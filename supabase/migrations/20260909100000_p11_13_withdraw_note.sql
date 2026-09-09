-- P11-13 — A NOTE ON A WITHDRAWAL, AND WITHDRAWING APPROVED LEAVE.
--
-- Two changes, and the second is the one that matters.
--
-- ---------------------------------------------------------------------------
-- 1. THE NOTE.
--
-- A team leader holding a leave request in their queue, or a reliever who has
-- been asked to cover a colleague's tasks, is told the request is gone and
-- nothing else. "It no longer needs your approval" answers WHAT and never WHY,
-- and the why is the half that decides whether they should expect the same
-- request back on Monday with different dates, or whether the cover they had
-- started arranging can be stood down for good.
--
-- OPTIONAL while nobody has answered. A person taking back a request no one has
-- looked at is not being asked to justify it — that is P9-03's asymmetry and it
-- is kept. REQUIRED the moment somebody has signed, which is change 2.
--
-- ---------------------------------------------------------------------------
-- 2. WITHDRAWAL AFTER APPROVAL — LEAVE ONLY, AND ONLY BEFORE IT STARTS.
--
-- P9-03 stopped withdrawal dead the moment anybody answered: "once anybody has
-- put their name to it, the way out is a rejection". That is right for a
-- request that has taken effect and wrong for one that has not. Leave approved
-- for next Tuesday is a plan, and plans change — forcing a rejection to undo it
-- writes a refusal into the record for something nobody refused, which is the
-- exact failure P9-03 was written to fix, one step further along.
--
-- ⚠️ LEAVE, AND NOTHING ELSE. This is not squeamishness — it is what the data
-- allows. EVERY consequence of approved leave is a `status = 'APPROVED'` filter
-- somewhere else: the calendar (p7_10, p7_42), balances (p7_33), the leave
-- report (p7_34, p7_53) and reliever coverage (p9_01) all read it live. Setting
-- the status to WITHDRAWN therefore undoes all of it with no compensating write
-- at all, and nothing can be left half-undone.
--
-- The other types are the opposite. Approving a time correction or overtime
-- REWRITES a vizserve_pms_dtr_entries row (P5-09, P7-39), and a reimbursement
-- authorises money. Withdrawing those needs a real reversal — a decision about
-- what an un-approved attendance record even means — and it is not this change.
-- They keep P9-03's rule exactly: once answered, the way out is a rejection.
--
-- ⚠️ AND ONLY BEFORE THE FIRST DAY. Once the leave has started the person is on
-- leave, and rewriting the record afterwards makes the calendar disagree with
-- what happened. `vizserve_pms_is_covering_task` also only grants a reliever
-- anything BETWEEN start and end, so a withdrawal before the start date takes
-- away nothing that was ever in force. Both halves fall out of the same date
-- test.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE ARITY TRAP, for the fifth time in this project.
--
-- This takes the function from ONE argument to TWO. `create or replace` with a
-- longer list creates a SECOND function rather than replacing the first, and
-- PostgREST resolves overloads BY ARGUMENT NAME — so a caller sending only
-- `p_id` matches both and gets an ambiguity error, which reads as withdrawal
-- being broken for everybody at once.
--
-- The one-argument version is dropped below, AFTER the new one is created, and
-- the new one is granted explicitly. Do not remove either statement.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_internal_requests
  add column if not exists withdrawn_note text;

-- ⚠️ NOT `decision_reason`, and the separation is the whole design.
--
-- `decision_reason` is what an APPROVER wrote when they approved or rejected,
-- and Phase 6 will report on it as a decision. A withdrawal is not a decision
-- and this note is not an approver's, so folding the two together would file
-- the requester's own words in the approver's column on every report that ever
-- reads it — the same conflation P9-03 introduced withdrawal to avoid, one
-- level down.
comment on column vizserve_pms_internal_requests.withdrawn_note is
  'P11-13. Optional rich text from the REQUESTER saying why they took the request back. Never an approver''s words — those are in decision_reason.';

-- A note on a request nobody withdrew is a note about nothing. Stated as a
-- constraint rather than left to the function, because the function is not the
-- only way a column gets written and the rule is about the row, not the call.
alter table vizserve_pms_internal_requests
  drop constraint if exists vizserve_pms_internal_requests_withdrawn_note;

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_withdrawn_note
  check (withdrawn_note is null or status = 'WITHDRAWN');

-- ===========================================================================
-- The function, with the note threaded through the three places it belongs:
-- the row, the audit entry, and the notification the waiting approver reads.
-- Everything else is P9-03 verbatim — the ownership test, the pending test and
-- the both-decision-logs test are unchanged, and this file must not be the
-- place they quietly drift.
-- ===========================================================================
create or replace function vizserve_pms_withdraw_internal_request(
  p_id   uuid,
  -- Rich text, already sanitised by the action. Null and '' both mean "no note"
  -- — the client sends '' for an editor the person opened and left empty, and
  -- storing seven characters of `<p></p>` as an explanation is the failure
  -- `richTextSchema` exists to prevent.
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     uuid := auth.uid();
  v_req      vizserve_pms_internal_requests;
  v_before   jsonb;
  v_approver record;
  v_name     text;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  -- P11-13. Has anybody put their name to this yet, in either decision log?
  v_signed   boolean;
  v_today    date := (now() at time zone 'Asia/Manila')::date;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- Locked for the same reason every other decision path locks: a withdrawal
  -- racing an approval must not produce a request that is both.
  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  -- Only the person who filed it. Not a lead, not an admin — a lead who wants
  -- this gone has `reject`, which asks them for a reason, and that asymmetry is
  -- the whole design: withdrawing owes nobody an explanation precisely because
  -- only the author can do it. P11-13 offers a note; it does not require one.
  if v_req.requester_id <> v_user then
    raise exception 'Only the person who filed a request can withdraw it.'
      using errcode = 'insufficient_privilege';
  end if;

  -- ⚠️ APPROVED IS NOW A LEGAL STARTING POINT, under the three rules below.
  -- REJECTED and WITHDRAWN stay terminal: a refusal is somebody's decision and
  -- withdrawing a withdrawal is not a thing.
  if v_req.status not in ('PENDING_REVIEW', 'APPROVED') then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  -- Both decision logs, because the chain writes to two places: stages 2 and 3
  -- go through vizserve_pms_record_decision into vizserve_pms_approvals, and a
  -- reliever's answer lives on their own row. Checking only the first would
  -- miss a request two of three relievers had already accepted.
  --
  -- `status = 'APPROVED'` is folded in rather than trusted to imply the rest: a
  -- stage-0 approval does write an approvals row, so the two agree today, and
  -- reading the status directly means they cannot come apart later.
  v_signed := v_req.status = 'APPROVED'
    or exists (
      select 1 from vizserve_pms_approvals a
       where a.entity_type = 'internal_request' and a.entity_id = p_id
    )
    or exists (
      select 1 from vizserve_pms_internal_request_relievers r
       where r.request_id = p_id and r.decision is not null
    );

  -- =========================================================================
  -- P11-13 — THE THREE RULES THAT APPLY ONCE SOMEBODY HAS SIGNED.
  --
  -- None of them applies before that: a request nobody has looked at is
  -- withdrawn exactly as P9-03 allowed, of any type, on any date, with or
  -- without a note.
  -- =========================================================================
  if v_signed then
    -- (a) LEAVE ONLY. See the header: leave is undone by this status flip
    -- alone, and every other type has written something that a status flip
    -- does not reach.
    --
    -- The wording is P9-03's, unchanged, because for these types the rule is
    -- unchanged and this is still the sentence that explains it.
    if v_req.request_type <> 'LEAVE' then
      raise exception 'Somebody has already answered this, so it cannot be withdrawn. Ask them to reject it instead.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- (b) BEFORE THE FIRST DAY. `<=` and not `<`: on the morning of the leave
    -- the person is already on it, whatever the clock says.
    if v_req.start_date is null or v_req.start_date <= v_today then
      raise exception 'This leave has already started, so it cannot be withdrawn. Ask a team leader to correct the record instead.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- (c) A NOTE, REQUIRED. Somebody arranged cover, or signed their name to
    -- it, on the strength of this request. They are owed the reason — which is
    -- exactly why the note is optional when nobody has done either.
    if v_note is null then
      raise exception 'Say why you are withdrawing this. Somebody has already approved it, and they will be told.'
        using errcode = 'check_violation';
    end if;
  end if;

  v_before := to_jsonb(v_req);

  update vizserve_pms_internal_requests
     set status = 'WITHDRAWN',
         withdrawn_note = v_note
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, 'withdrawn', v_user, v_before,
    jsonb_build_object(
      'status', 'WITHDRAWN',
      'approval_stage', v_req.approval_stage,
      -- Recorded as a fact of the withdrawal, not only on the row: the row can
      -- be read at any time, but the trail is what says the note was written
      -- AT the withdrawal rather than added to it afterwards.
      'withdrawn_note', v_note,
      -- ⚠️ P11-13. WHAT IT WAS WITHDRAWN FROM, and Phase 6 needs it. "Withdrawn
      -- before anybody looked" and "withdrawn after a manager approved it" are
      -- the same status and very different facts — one is a person tidying up
      -- after themselves, the other is signed-off leave that did not happen.
      -- The status column cannot tell them apart and the before-image is a full
      -- row dump nobody reports on, so it is stated here plainly.
      'withdrawn_from', v_req.status::text,
      'was_signed', v_signed
    )
  );

  select u.full_name into v_name from vizserve_pms_users u where u.id = v_user;

  -- Whoever it was actually waiting on is told it is gone. Leaving them to
  -- discover an empty queue is how a person keeps a tab open on work that no
  -- longer exists.
  --
  -- `internal_decision`, not a new notification type: a new
  -- vizserve_pms_notification_type value with no settings row is a notification
  -- whose email is silently and permanently off (docs/13:190). This one is
  -- inbox-only by that row's own setting, which is right — it is housekeeping.
  --
  -- ⚠️ THE STANDING SENTENCE STAYS AND THE NOTE IS APPENDED. It would read more
  -- neatly to let the note replace it, but the two say different things: the
  -- sentence is what the reader must DO, the note is why. A reliever told only
  -- "changed my mind, sorry" has not been told they can stand down.
  --
  -- Concatenated as markup because the note is already sanitised rich text and
  -- the inbox flattens the body with `richTextToPlainText` before showing it.
  -- Two plain loops rather than one clever query, for the reason P9-03 gives.
  --
  -- ⚠️ P11-13 — ONCE SOMEBODY HAS SIGNED, THE AUDIENCE IS THE SIGNERS, and the
  -- stage no longer decides it. A team leader who approved this on Monday is
  -- not "whoever it is waiting on" — it is waiting on nobody, it was finished —
  -- and they are precisely the person who must not find out by opening the
  -- calendar next week. Same for a reliever who accepted the hand-over.
  --
  -- A UNION of the two decision logs, for the reason the guard above reads
  -- both. `union` and not `union all`: a person can appear in only one of them
  -- today, and a duplicate notification would be the kind of bug nobody
  -- notices until somebody is told twice.
  --
  -- The body is deliberately the same for both. "Nothing further is needed from
  -- you" is true of a reliever who was going to cover the work and of a manager
  -- who had already signed, and inventing two sentences to say it twice is how
  -- one of them ends up wrong.
  if v_signed then
    for v_approver in
      select r.reliever_id as user_id
        from vizserve_pms_internal_request_relievers r
        join vizserve_pms_users u on u.id = r.reliever_id
       where r.request_id = p_id and r.decision is not null
         and u.is_active and u.id <> v_user
      union
      select a.approver_id as user_id
        from vizserve_pms_approvals a
        join vizserve_pms_users u on u.id = a.approver_id
       where a.entity_type = 'internal_request' and a.entity_id = p_id
         and u.is_active and u.id <> v_user
    loop
      perform vizserve_pms_notify(
        v_approver.user_id, 'internal_decision',
        coalesce(v_name, 'A colleague') || ' withdrew leave you had signed',
        '<p>Nothing further is needed from you.</p>' || v_note,
        'internal_request', p_id, '/approvals/' || p_id::text
      );
    end loop;

  -- Stage 3 notifies nobody: reaching it means two decisions exist, so it is
  -- always the signed path above.
  elsif v_req.approval_stage = 1 then
    for v_approver in
      select r.reliever_id as user_id
        from vizserve_pms_internal_request_relievers r
        join vizserve_pms_users u on u.id = r.reliever_id
       where r.request_id = p_id and u.is_active and u.id <> v_user
    loop
      perform vizserve_pms_notify(
        v_approver.user_id, 'internal_decision',
        coalesce(v_name, 'A colleague') || ' withdrew their leave request',
        '<p>You no longer need to cover their work.</p>' || coalesce(v_note, ''),
        'internal_request', p_id, '/approvals/' || p_id::text
      );
    end loop;
  else
    for v_approver in
      select md.user_id
        from vizserve_pms_user_managed_departments md
        join vizserve_pms_users u on u.id = md.user_id
       where md.department_id = v_req.department_id
         and u.is_active and u.id <> v_user
    loop
      perform vizserve_pms_notify(
        v_approver.user_id, 'internal_decision',
        coalesce(v_name, 'A colleague') || ' withdrew a request',
        '<p>It no longer needs your approval.</p>' || coalesce(v_note, ''),
        'internal_request', p_id, '/approvals/' || p_id::text
      );
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'status', 'WITHDRAWN');
end;
$$;

-- ⚠️ The one-argument version has to go. See the header.
drop function if exists vizserve_pms_withdraw_internal_request(uuid);

grant execute on function vizserve_pms_withdraw_internal_request(uuid, text) to authenticated;

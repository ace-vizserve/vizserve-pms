-- P9-04 — DECIDING A CHAINED REQUEST.
--
-- The last of the four. P9-01 added the columns, P9-03 started setting them,
-- and until this file runs a leave request opened at stage 2 is still decided
-- in one step by one lead. Applying this is what turns the chain on.
--
-- ---------------------------------------------------------------------------
-- ⚠️ HOW THIS FILE TREATS vizserve_pms_decide_internal_request.
--
-- That function names the four correction types in SEVEN places and has been
-- broken twice by rewrites that looked like tidying. P7-16 broke it loudly;
-- P7-39's header describes the silent version, where a missed `case` branch
-- yields null, writes the existing time straight back, and still returns a
-- non-null dtr_entry_id — every signal the app can see saying it worked while
-- the DTR is unchanged.
--
-- So this migration does NOT restructure it. The chain is a single branch
-- inserted after the existing guards and BEFORE the existing
-- `vizserve_pms_record_decision` call, and it returns from inside itself.
-- Everything below that branch is byte-for-byte the P7-39 body.
--
-- The early return is safe because the DTR write-back is guarded on
-- `v_fixes_in or v_fixes_out`, and LEAVE — the only type that can carry a stage
-- at all, per the P9-01 constraint — is neither.
--
-- Signature unchanged, so: create or replace, no drop, no regrant.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- FIRST: who may decide a chained request.
--
-- One function, and it is the only place stages 2 and 3 are answered — for the
-- decide function AND for the engine, which calls it too. Two copies of "is
-- this manager allowed" is how the two would disagree.
--
-- Stage 1 is deliberately NOT here. A reliever's authority is "there is an
-- undecided row with my name on it", which is a lookup on a specific row rather
-- than a rule about a person, and the decide function tests it by selecting
-- that row `for update` — which it has to do anyway.
-- ===========================================================================
create or replace function vizserve_pms_may_decide_internal_stage(
  p_entity_type text,
  p_entity_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_internal_requests r
      join vizserve_pms_users u on u.id = auth.uid()
     where p_entity_type = 'internal_request'
       and r.id = p_entity_id
       and r.status = 'PENDING_REVIEW'
       and u.is_active
       and (
         -- Stage 2 — the department's team leader. Same authority the single
         -- decision always used, stated through `_for` because this function is
         -- also read on behalf of the engine.
         (
           r.approval_stage = 2
           and u.role >= 'team_leader'
           and vizserve_pms_manages_department_for(u.id, r.department_id)
         )
         -- Stage 3 — a manager, and NO DEPARTMENT TEST. Amier, 4 Sep: the team
         -- manager has oversight over all departments. This is the one place in
         -- this schema where approval authority is company-wide rather than
         -- scoped to a managed department, and it is narrow on purpose — it
         -- reaches only leave requests that have already cleared their own
         -- lead, never client requests, timesheet weeks, reimbursements, or a
         -- leave request still sitting at stage 2.
         --
         -- `>= 'manager'` uses the enum's declaration order (member <
         -- team_leader < manager < admin < owner), so owner is included and
         -- admin — a dead rung since P8-01a — is harmlessly along for the ride.
         or (r.approval_stage = 3 and u.role >= 'manager')
       )
  );
$$;

grant execute on function vizserve_pms_may_decide_internal_stage(text, uuid) to authenticated;

-- ===========================================================================
-- THE ONE ENGINE EDIT IN THIS WHOLE FEATURE.
--
-- P2-00's header draws a line around what the engine owns, and "routing by
-- department" is inside it. A stage-3 manager who leads no department fails
-- `vizserve_pms_can_approve` and cannot be recorded — so either the engine
-- learns about them, or the chain grows a second decision path that writes to
-- vizserve_pms_approvals without passing through here.
--
-- The second option is the one the engine's header calls the bug: "If a future
-- internal type finds itself re-implementing approve/reject here, the Phase 2
-- abstraction has failed." So it is one clause, and "may this person decide"
-- keeps a single home.
--
-- ⚠️ THE INVARIANT THAT MAKES THIS SAFE: vizserve_pms_may_decide_internal_stage
-- returns FALSE for every entity type but 'internal_request', and false for any
-- internal request at stage 0 or 1. Client requests (Gate 1), timesheet weeks
-- (P7-05) and every unchained internal request therefore evaluate exactly the
-- expression they did before. Break that invariant and this clause becomes a
-- company-wide approval bypass.
--
-- Body reproduced in full from p2_00; the `if not (...)` is the only change.
-- ===========================================================================
create or replace function vizserve_pms_record_decision(
  p_entity_type   text,
  p_entity_id     uuid,
  p_department_id uuid,
  p_decision      vizserve_pms_approval_decision,
  p_reason        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_approver uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id       uuid;
begin
  if v_approver is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- P9-04. The second half is the addition. See the header.
  if not (
    vizserve_pms_can_approve(p_department_id)
    or vizserve_pms_may_decide_internal_stage(p_entity_type, p_entity_id)
  ) then
    raise exception 'That is outside your approval scope.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Checked here as well as in the table constraint, so the caller gets a
  -- sentence rather than a constraint name.
  if p_decision <> 'approved' and v_reason is null then
    raise exception 'A reason is required to % this.',
      case p_decision when 'returned' then 'return' else 'reject' end
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_approvals
    (entity_type, entity_id, department_id, approver_id, decision, reason)
  values
    (p_entity_type, p_entity_id, p_department_id, v_approver, p_decision, v_reason)
  returning id into v_id;

  perform vizserve_pms_write_audit_log(
    p_entity_type,
    p_entity_id,
    p_decision::text,
    v_approver,
    null,
    jsonb_build_object('decision', p_decision, 'reason', v_reason)
  );

  return v_id;
end;
$$;

-- Signature unchanged; the P2-00 grant stands.

-- ===========================================================================
-- THE DECISION.
-- ===========================================================================
create or replace function vizserve_pms_decide_internal_request(
  p_id       uuid,
  p_decision vizserve_pms_approval_decision,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req       vizserve_pms_internal_requests;
  v_before    jsonb;
  v_status    vizserve_pms_internal_request_status;
  v_entry_id  uuid;
  v_existing  vizserve_pms_dtr_entries;
  -- P7-39. Assigned once, read seven times.
  v_fixes_in  boolean;
  v_fixes_out boolean;
  -- P9-04
  v_actor     uuid := auth.uid();
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rejected  boolean := (p_decision = 'rejected');
  v_row       vizserve_pms_internal_request_relievers;
  v_next      smallint;
  v_owed      integer;
  v_person    record;
  v_name      text;
begin
  if p_decision = 'returned' then
    raise exception 'Internal requests are approved or rejected, not returned.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  v_fixes_in  := v_req.request_type in ('NO_TIME_IN',  'TIME_IN_CORRECTION');
  v_fixes_out := v_req.request_type in ('NO_TIME_OUT', 'TIME_OUT_CORRECTION');

  -- Same guard as Gate 1: two approvers clicking seconds apart must not both
  -- succeed, or the second silently overwrites the first one's decision.
  if v_req.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  -- Nobody approves their own leave. The engine checks departmental scope, but
  -- a team leader IS in the department they lead, so scope alone would let them
  -- self-approve. It also covers the P9-03 case a submit-time rule already
  -- refuses — naming yourself as your own reliever.
  if v_req.requester_id = v_actor then
    raise exception 'You cannot decide your own request.'
      using errcode = 'insufficient_privilege';
  end if;

  -- =========================================================================
  -- P9-04 — THE CHAIN. Returns from inside; everything after `end if` is the
  -- untouched single-decision path for stage 0.
  -- =========================================================================
  if v_req.approval_stage > 0 then
    v_before := to_jsonb(v_req);
    select u.full_name into v_name from vizserve_pms_users u where u.id = v_req.requester_id;

    -- ----------------------------------------------------------- stage 1
    if v_req.approval_stage = 1 then
      -- Authority IS the row. Locked, so two relievers answering at once
      -- cannot both read "one still owed" and both leave it at stage 1.
      select * into v_row
        from vizserve_pms_internal_request_relievers
       where request_id = p_id and reliever_id = v_actor
       for update;

      if v_row.id is null then
        raise exception 'This is waiting on the relievers named on it.'
          using errcode = 'insufficient_privilege';
      end if;

      if v_row.decision is not null then
        raise exception 'You have already answered this.'
          using errcode = 'invalid_parameter_value';
      end if;

      -- Enforced here because a reliever's answer does NOT go through
      -- vizserve_pms_record_decision, so the engine is not around to say it.
      -- The table constraint says it too, as a constraint name.
      if v_rejected and v_reason is null then
        raise exception 'Say why you cannot take this on — a refusal with no reason is unactionable.'
          using errcode = 'check_violation';
      end if;

      update vizserve_pms_internal_request_relievers
         set decision = p_decision, decided_at = now(), reason = v_reason
       where id = v_row.id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'reliever_' || p_decision::text, v_actor, null,
        jsonb_build_object('reliever_id', v_actor, 'decision', p_decision, 'reason', v_reason)
      );

      if not v_rejected then
        select count(*) into v_owed
          from vizserve_pms_internal_request_relievers
         where request_id = p_id and decision is null;

        -- The other relievers are still owed. Nothing moves, nobody is told,
        -- and the request stays exactly where it was — an approval that
        -- advanced the stage on the first yes would put it in front of the lead
        -- while somebody was still being asked to take four tasks.
        if v_owed > 0 then
          return jsonb_build_object(
            'ok', true, 'status', v_req.status::text,
            'approval_stage', 1, 'stage_complete', false, 'dtr_entry_id', null
          );
        end if;
      end if;

      v_next := 2;

    -- ------------------------------------------------------- stages 2 and 3
    else
      if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
        raise exception '%',
          case v_req.approval_stage
            when 2 then 'This is waiting on a team leader of that department.'
            else 'This is waiting on a manager.'
          end
          using errcode = 'insufficient_privilege';
      end if;

      -- ⚠️ TWO GATES, TWO PEOPLE. A manager who also leads the requester's
      -- department satisfies stage 2 AND stage 3, so without this they could
      -- approve at stage 2 and then approve their own approval — a chain that
      -- looks like two signatures in the audit trail and is one person twice.
      -- Rare in a small company, and precisely the arrangement that makes it
      -- likely rather than unlikely.
      --
      -- The second gate then needs somebody else. If no other manager exists,
      -- that is a staffing fact for an admin to fix, not a rule to soften.
      if exists (
        select 1 from vizserve_pms_approvals a
         where a.entity_type = 'internal_request'
           and a.entity_id = p_id
           and a.approver_id = v_actor
      ) then
        raise exception 'You already approved this at an earlier stage. It needs somebody else.'
          using errcode = 'insufficient_privilege';
      end if;

      -- THE ENGINE CALL, unchanged in shape from P5-08. It re-checks authority
      -- itself — through the same function tested above — and owns the
      -- mandatory reason, the approval row and its audit entry.
      perform vizserve_pms_record_decision(
        'internal_request', p_id, v_req.department_id, p_decision, p_reason
      );

      v_next := case when v_req.approval_stage = 2 then 3 else null end;
    end if;

    -- ------------------------------------------------------- a refusal ends it
    --
    -- Terminal at every stage, including stage 1: a reliever saying "I cannot
    -- take these four tasks" is a real answer to the request as filed, and the
    -- honest next step is a new request with a different hand-over. There is no
    -- RETURNED for internal requests and this does not invent one.
    if v_rejected then
      update vizserve_pms_internal_requests
         set status = 'REJECTED', decision_reason = v_reason,
             reviewed_by = v_actor, reviewed_at = now()
       where id = p_id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'rejected', v_actor, v_before,
        jsonb_build_object('status', 'REJECTED', 'reason', v_reason,
                           'rejected_at_stage', v_req.approval_stage)
      );

      perform vizserve_pms_notify(
        v_req.requester_id, 'internal_decision',
        replace(v_req.request_type::text, '_', ' ') || ' request rejected',
        coalesce(v_reason, ''), 'internal_request', p_id,
        '/approvals/' || p_id::text
      );

      return jsonb_build_object(
        'ok', true, 'status', 'REJECTED',
        'approval_stage', v_req.approval_stage, 'stage_complete', true,
        'dtr_entry_id', null
      );
    end if;

    -- ------------------------------------------------- approved, more to come
    if v_next is not null then
      update vizserve_pms_internal_requests
         set approval_stage = v_next
       where id = p_id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'stage_advanced', v_actor, v_before,
        jsonb_build_object('from_stage', v_req.approval_stage, 'to_stage', v_next)
      );

      if v_next = 2 then
        -- The leads, at last. This is the notification P9-03 held back while
        -- the relievers were still answering.
        for v_person in
          select md.user_id
            from vizserve_pms_user_managed_departments md
            join vizserve_pms_users u on u.id = md.user_id
           where md.department_id = v_req.department_id
             and u.is_active and u.id <> v_req.requester_id
        loop
          perform vizserve_pms_notify(
            v_person.user_id, 'pending_approval',
            'Leave request from ' || coalesce(v_name, 'a colleague'),
            'The relievers have accepted the hand-over.',
            'internal_request', p_id, '/approvals/' || p_id::text
          );
        end loop;
      else
        -- Every manager, company-wide, matching the authority at stage 3. The
        -- requester is excluded for the same reason they always are: a manager
        -- filing their own leave cannot decide it.
        for v_person in
          select u.id as user_id
            from vizserve_pms_users u
           where u.is_active and u.role >= 'manager' and u.id <> v_req.requester_id
        loop
          perform vizserve_pms_notify(
            v_person.user_id, 'pending_approval',
            'Leave for final approval: ' || coalesce(v_name, 'a colleague'),
            'Approved by their team leader.',
            'internal_request', p_id, '/approvals/' || p_id::text
          );
        end loop;
      end if;

      return jsonb_build_object(
        'ok', true, 'status', v_req.status::text,
        'approval_stage', v_next, 'stage_complete', true, 'dtr_entry_id', null
      );
    end if;

    -- ------------------------------------------------------------- finished
    update vizserve_pms_internal_requests
       set status = 'APPROVED',
           decision_reason = v_reason,
           reviewed_by = v_actor, reviewed_at = now()
     where id = p_id;

    perform vizserve_pms_write_audit_log(
      'internal_request', p_id, 'approved', v_actor, v_before,
      jsonb_build_object('status', 'APPROVED', 'reason', v_reason, 'final_stage', 3)
    );

    perform vizserve_pms_notify(
      v_req.requester_id, 'internal_decision',
      replace(v_req.request_type::text, '_', ' ') || ' request approved',
      coalesce(v_reason, ''), 'internal_request', p_id,
      '/approvals/' || p_id::text
    );

    -- ⚠️ NO DTR WRITE-BACK HERE, and none is missing. Only LEAVE can carry a
    -- stage — the P9-01 constraint refuses any other type — and leave has never
    -- written a DTR row. The four correction types run the path below, which is
    -- untouched.
    return jsonb_build_object(
      'ok', true, 'status', 'APPROVED',
      'approval_stage', 3, 'stage_complete', true, 'dtr_entry_id', null
    );
  end if;

  -- =========================================================================
  -- STAGE 0 — everything below this line is the P7-39 body, unchanged.
  -- =========================================================================

  -- THE ENGINE CALL. Scope, the mandatory reason on reject, the approval row
  -- and its audit entry are all handled in there.
  perform vizserve_pms_record_decision(
    'internal_request', p_id, v_req.department_id, p_decision, p_reason
  );

  v_before := to_jsonb(v_req);
  v_status := case p_decision when 'approved' then 'APPROVED' else 'REJECTED' end;

  update vizserve_pms_internal_requests
     set status          = v_status,
         decision_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_id;

  -- ----------------------------------------------------------- P5-09 / P7-39
  if v_status = 'APPROVED' and (v_fixes_in or v_fixes_out) then
    select * into v_existing
      from vizserve_pms_dtr_entries
     where user_id = v_req.requester_id and work_date = v_req.work_date;

    -- Checked before writing so the caller gets a sentence instead of a
    -- constraint name from vizserve_pms_dtr_entries_out_after_in.
    if v_fixes_in
       and v_existing.time_out is not null
       and v_req.correction_at > v_existing.time_out then
      raise exception 'That time-in is after the recorded time-out on %. Correct the time-out first.', v_req.work_date
        using errcode = 'check_violation';
    end if;

    if v_fixes_out
       and v_existing.time_in is not null
       and v_req.correction_at < v_existing.time_in then
      raise exception 'That time-out is before the recorded time-in on %. Correct the time-in first.', v_req.work_date
        using errcode = 'check_violation';
    end if;

    -- Assigned, NOT coalesced, and NOT greatest(). This is the one path allowed
    -- to overwrite an earliest-in, and that is the entire reason the correction
    -- forms exist — P5-02 makes the punch itself unoverwritable on purpose, so
    -- the only way back is through an approval somebody else signed off.
    --
    -- P7-39 leans on this harder than P5-09 did: a TIME_OUT_CORRECTION routinely
    -- moves a time-out EARLIER, which is precisely the write vizserve_pms_punch
    -- refuses with greatest(). Reintroduce either function's protective idiom
    -- here and approving such a correction silently does nothing.
    insert into vizserve_pms_dtr_entries (
      user_id, work_date, time_in, time_out,
      corrected_by, corrected_at, correction_request_id
    ) values (
      v_req.requester_id,
      v_req.work_date,
      case when v_fixes_in then v_req.correction_at end,
      case when v_fixes_out then v_req.correction_at end,
      auth.uid(), now(), p_id
    )
    on conflict (user_id, work_date) do update
       set time_in = case
             when v_fixes_in then v_req.correction_at
             else vizserve_pms_dtr_entries.time_in
           end,
           time_out = case
             when v_fixes_out then v_req.correction_at
             else vizserve_pms_dtr_entries.time_out
           end,
           corrected_by = auth.uid(),
           corrected_at = now(),
           correction_request_id = p_id
    returning id into v_entry_id;

    perform vizserve_pms_write_audit_log(
      'dtr_entry', v_entry_id, 'corrected', auth.uid(),
      case when v_existing.id is null then null else to_jsonb(v_existing) end,
      jsonb_build_object(
        'request_type', v_req.request_type,
        'work_date', v_req.work_date,
        'correction_at', v_req.correction_at,
        'internal_request_id', p_id
      )
    );
  end if;

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, lower(v_status::text), auth.uid(), v_before,
    jsonb_build_object('status', v_status, 'reason', p_reason, 'dtr_entry_id', v_entry_id)
  );

  perform vizserve_pms_notify(
    v_req.requester_id,
    'internal_decision',
    replace(v_req.request_type::text, '_', ' ') || ' request ' || lower(v_status::text),
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), ''),
    'internal_request',
    p_id,
    '/approvals/' || p_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'dtr_entry_id', v_entry_id
  );
end;
$$;

grant execute on function vizserve_pms_decide_internal_request(
  uuid, vizserve_pms_approval_decision, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- ONE RLS CHANGE, and it is the one without which stage 3 is unreachable.
--
-- The policy on vizserve_pms_internal_requests is "requester, or a lead of the
-- snapshotted department, or HR". A manager who leads no department satisfies
-- none of those, so a request sitting at stage 3 would be invisible to every
-- person entitled to decide it — the decide function would work and no screen
-- could reach it.
--
-- NARROW ON PURPOSE, in three ways at once. It grants a manager sight of a
-- request only once it has reached stage 3 — which means only leave, and only
-- leave the requester's own team leader has already approved — and only WHILE
-- IT IS STILL WAITING, or afterwards if they are the one who decided it.
--
-- That last clause is not tidiness. Without it, `approval_stage = 3` alone
-- would leave every manager reading every leave request in the company for
-- ever, because the stage never resets after approval. P7-12 withholds the
-- leave TYPE from the shared calendar on the grounds that four of the nine
-- types are health, pregnancy, family-structure and gynaecological disclosures
-- about a named colleague; a policy that hands all nine plus the free-text
-- reason to every manager permanently would undo that decision sideways.
--
-- A manager keeps what they signed. They do not keep what they merely could
-- have signed.
--
-- ADDITIVE. Postgres ORs multiple permissive policies on the same command, so
-- the existing three policies are untouched and nobody loses access.
-- ---------------------------------------------------------------------------
create policy "internal requests at final approval readable by managers"
  on vizserve_pms_internal_requests for select to authenticated
  using (
    approval_stage = 3
    and (status = 'PENDING_REVIEW' or reviewed_by = auth.uid())
    and exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid() and u.is_active and u.role >= 'manager'
    )
  );

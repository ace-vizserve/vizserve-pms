-- P9-03 — SUBMIT WITH RELIEVERS, AND WITHDRAWAL.
--
-- Two things land here:
--
--   1. `vizserve_pms_submit_internal_request` learns about relievers and sets
--      the approval stage. This is where leave stops being a one-signature
--      request: every leave now opens at stage 2 (team leader) and reliever
--      leave opens at stage 1 (the relievers themselves).
--
--   2. `vizserve_pms_withdraw_internal_request` — the submitter takes it back.
--      New, and general to every internal request type rather than leave-only.
--
-- ⚠️ RUN 20260905091000_p9_02_withdrawn_status.sql FIRST, as its own statement.
-- This file writes 'WITHDRAWN' and Postgres refuses a new enum value in the
-- transaction that adds it.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE ARITY TRAP, for the fourth time in this project.
--
-- This takes the function from ELEVEN arguments to THIRTEEN. `create or
-- replace` with a longer list creates a SECOND function rather than replacing
-- the first, and PostgREST resolves overloads BY ARGUMENT NAME — so a caller
-- sending the old eleven matches both and gets an ambiguity error, which reads
-- as a total failure of every internal request form at once.
--
-- The eleven-argument version is dropped below, after the new one is created,
-- and the new one is granted explicitly. Do not remove either statement.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_submit_internal_request(
  p_request_type    vizserve_pms_internal_request_type,
  p_reason          text,
  p_start_date      date default null,
  p_end_date        date default null,
  p_work_date       date default null,
  -- Wall-clock time on p_work_date, e.g. '08:00'. Combined with the date in
  -- Manila below; the client never sends an instant.
  p_correction_time time default null,
  p_amount          numeric default null,
  p_overtime_minutes integer default null,
  p_leave_type_id   uuid default null,
  p_start_half      vizserve_pms_day_half default 'MORNING',
  p_end_half        vizserve_pms_day_half default 'AFTERNOON',
  -- P9-03. `[{ "reliever_id": uuid, "task_ids": [uuid, ...] }, ...]`
  --
  -- JSONB rather than two parallel arrays because the shape is a nesting, and
  -- `uuid[]` plus `uuid[][]` would make "which tasks belong to which reliever"
  -- a matter of index alignment between two parameters — the kind of implicit
  -- contract that survives exactly until somebody filters one of them.
  p_relievers       jsonb default null,
  p_turnover_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_correction timestamptz;
  v_id         uuid;
  v_approver   record;
  v_name       text;
  -- P9-03
  v_requires_reliever boolean := false;
  v_relievers  jsonb;
  v_count      integer;
  v_stage      smallint := 0;
  v_entry      record;
  v_task       record;
  v_reliever   uuid;
  v_row_id     uuid;
  v_tasks      integer;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select u.primary_department_id, u.full_name into v_department, v_name
    from vizserve_pms_users u
   where u.id = v_user and u.is_active;

  if v_name is null then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if v_department is null then
    raise exception 'You have no department set, so there is nobody to approve this. Ask an admin to set your department.'
      using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'Say why you are requesting this.' using errcode = 'check_violation';
  end if;

  if p_request_type = 'LEAVE' then
    if p_leave_type_id is null then
      raise exception 'Choose what kind of leave this is.' using errcode = 'check_violation';
    end if;

    -- P9-03 reads `requires_reliever` off the same row P7-12 already checks for
    -- `is_active`, so this is one lookup rather than two.
    select lt.requires_reliever into v_requires_reliever
      from vizserve_pms_leave_types lt
     where lt.id = p_leave_type_id and lt.is_active;

    if v_requires_reliever is null then
      raise exception 'That leave type is no longer available. Pick one from the list.'
        using errcode = 'check_violation';
    end if;

    -- P7-16. The constraint says the same thing, but a constraint violation
    -- reads as a constraint name. This is the sentence somebody can act on.
    if p_start_date = p_end_date and p_start_half > p_end_half then
      raise exception 'Leave on one day cannot start in the afternoon and end in the morning.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ⚠️ P7-39: all four correction types compose an instant the same way and
  -- refuse the future the same way.
  if p_request_type in (
    'NO_TIME_IN', 'NO_TIME_OUT', 'TIME_IN_CORRECTION', 'TIME_OUT_CORRECTION'
  ) then
    if p_work_date is null or p_correction_time is null then
      raise exception 'A correction needs the date and the time it should have been.'
        using errcode = 'check_violation';
    end if;

    v_correction := (p_work_date::text || ' ' || p_correction_time::text)::timestamp
                    at time zone 'Asia/Manila';

    if v_correction > now() then
      raise exception 'You cannot correct a time that has not happened yet.'
        using errcode = 'check_violation';
    end if;
  end if;

  if p_request_type = 'OVERTIME' then
    if p_work_date is null or p_overtime_minutes is null then
      raise exception 'Overtime needs the day and how long it ran.'
        using errcode = 'check_violation';
    end if;

    if p_work_date > (now() at time zone 'Asia/Manila')::date then
      raise exception 'Pick the day the overtime was or is being worked, not a future one.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- =========================================================================
  -- P9-03 — THE RELIEVER PAYLOAD.
  --
  -- Validated in full BEFORE the request row is inserted, so a request that
  -- fails any rule below leaves nothing behind at all. Everything here raises,
  -- and a raise in a plpgsql body rolls the whole function back — the same
  -- property vizserve_pms_approve_request relies on.
  --
  -- Every message is a SENTENCE. A person filling this in has just picked three
  -- colleagues and a dozen tasks off two dropdowns, and "violates check
  -- constraint vizserve_pms_reliever_..." tells them nothing about which one to
  -- change.
  -- =========================================================================

  -- Ignored rather than refused when the type does not want them. The client
  -- can send a stale array after somebody switches the leave type in the dialog,
  -- and refusing that is a worse error message than dropping it — the same call
  -- `leave_type_id` and the two halves already make for the other types.
  v_relievers := case
    when p_request_type = 'LEAVE' and coalesce(v_requires_reliever, false)
    then coalesce(p_relievers, '[]'::jsonb)
    else '[]'::jsonb
  end;

  if jsonb_typeof(v_relievers) <> 'array' then
    raise exception 'The reliever list is malformed.' using errcode = 'check_violation';
  end if;

  select count(*) into v_count from jsonb_array_elements(v_relievers);

  if coalesce(v_requires_reliever, false) then
    if v_count = 0 then
      raise exception 'This kind of leave needs a reliever. Add at least one.'
        using errcode = 'check_violation';
    end if;

    -- Three is Amier's ceiling. Past that the turn-over is not a hand-over, it
    -- is a redistribution, and it wants a conversation rather than a form.
    if v_count > 3 then
      raise exception 'Name at most three relievers.' using errcode = 'check_violation';
    end if;

    -- THE ATTESTATION IS A GATE, not a formality. The whole reliever block is
    -- the requester asserting that the critical work is listed and covered;
    -- without the tick, nobody has asserted anything and the three people below
    -- are being asked to approve a claim that was never made.
    if not coalesce(p_turnover_confirmed, false) then
      raise exception 'Confirm the turn-over before submitting.' using errcode = 'check_violation';
    end if;
  end if;

  -- The same person listed twice is not two approvals. The unique index would
  -- refuse it, but as a constraint name.
  if v_count <> (
    select count(distinct e.value ->> 'reliever_id') from jsonb_array_elements(v_relievers) e
  ) then
    raise exception 'That person is already listed as a reliever.' using errcode = 'check_violation';
  end if;

  -- One task, one reliever. Two people "covering" the same task is nobody
  -- covering it, and the coverage badge would have to name two.
  if (
    select count(*) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) <> (
    select count(distinct t.value) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) then
    raise exception 'Each task can only go to one reliever.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id, start_half, end_half,
    approval_stage, turnover_confirmed_at
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end,
    -- Coerced to null for every other type: the constraint would refuse a stray
    -- value, but refusing a request because the client sent a field it had no
    -- business sending is a worse error message than ignoring it.
    case when p_request_type = 'LEAVE' then coalesce(p_start_half, 'MORNING') else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_end_half, 'AFTERNOON') else null end,
    -- ⚠️ THE ONE LINE THAT DECIDES THE WHOLE WORKFLOW.
    --
    --   non-leave  -> 0, decided once by any lead, exactly as before
    --   leave      -> 2, team leader then manager
    --   + reliever -> 1, the relievers first
    --
    -- If the chain should ever cover overtime or reimbursement too, THIS is the
    -- expression that changes and nothing else in these four migrations does.
    case
      when p_request_type <> 'LEAVE' then 0
      when coalesce(v_requires_reliever, false) then 1
      else 2
    end,
    case when v_count > 0 then now() else null end
  )
  returning id into v_id;

  -- -------------------------------------------------------------------------
  -- The reliever rows, and the per-person rules.
  --
  -- These run AFTER the insert because the task links need the request id, and
  -- that is safe: a raise below still rolls the request row back with them.
  -- -------------------------------------------------------------------------
  for v_entry in select value as payload from jsonb_array_elements(v_relievers) loop
    v_reliever := nullif(v_entry.payload ->> 'reliever_id', '')::uuid;

    if v_reliever is null then
      raise exception 'Choose a reliever, or remove the empty row.' using errcode = 'check_violation';
    end if;

    -- The rule Amier gave: your own department, and never yourself. Checked
    -- separately from the department test so "you cannot be your own reliever"
    -- is not answered with "pick somebody from your own department", which is
    -- technically true and completely unhelpful.
    if v_reliever = v_user then
      raise exception 'You cannot be your own reliever.' using errcode = 'check_violation';
    end if;

    if not exists (
      select 1 from vizserve_pms_users u
       where u.id = v_reliever and u.is_active
         and u.primary_department_id = v_department
    ) then
      raise exception 'Pick a reliever from your own department.' using errcode = 'check_violation';
    end if;

    insert into vizserve_pms_internal_request_relievers (request_id, reliever_id)
    values (v_id, v_reliever)
    returning id into v_row_id;

    v_tasks := 0;

    for v_task in
      select value::uuid as task_id from jsonb_array_elements_text(v_entry.payload -> 'task_ids')
    loop
      -- ⚠️ THE AUTHORITY CHECK, and it is `is_on_task` rather than
      -- `assignee_id = v_user`. Since P7-13 a person can be on a task through
      -- vizserve_pms_task_assignees without being the PIC, and that work is
      -- just as much theirs to hand over. Testing the PIC column alone would
      -- silently make half of somebody's workload un-handoverable.
      --
      -- Note this is NOT restricted to the requester's own department. The task
      -- may belong to another team; it is the requester's work either way, and
      -- they are the one delegating it.
      if not vizserve_pms_is_on_task(v_task.task_id, v_user) then
        raise exception 'You are not on one of the tasks you tried to hand over.'
          using errcode = 'check_violation';
      end if;

      if exists (
        select 1 from vizserve_pms_tasks t
         where t.id = v_task.task_id
           and t.status in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
      ) then
        raise exception 'One of those tasks is already finished — it needs no reliever.'
          using errcode = 'check_violation';
      end if;

      insert into vizserve_pms_internal_request_reliever_tasks (reliever_row_id, task_id)
      values (v_row_id, v_task.task_id);

      v_tasks := v_tasks + 1;
    end loop;

    -- A reliever with no work is a name on a form and an approval nobody can
    -- reason about. The point of the stage is that the person taking the tasks
    -- agrees to take THOSE tasks.
    if v_tasks = 0 then
      raise exception 'Give every reliever at least one task.' using errcode = 'check_violation';
    end if;
  end loop;

  -- Six arguments. `v_user` is the ACTOR (fourth), `null` the before-image
  -- (fifth), the payload the after-image (sixth). Repaired in P7-16a; restated
  -- here because this file replaces the whole body.
  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object(
      'request_type', p_request_type,
      'department_id', v_department,
      -- P9-03. The turn-over is an attestation, so what was attested to is part
      -- of the record and not only the fact that a box was ticked.
      'approval_stage', case
        when p_request_type <> 'LEAVE' then 0
        when coalesce(v_requires_reliever, false) then 1
        else 2
      end,
      'relievers', v_relievers
    )
  );

  -- =========================================================================
  -- WHO HEARS ABOUT IT, which now depends on where the request starts.
  -- =========================================================================
  if v_count > 0 then
    -- Stage 1. THE LEADS ARE NOT TOLD YET, and that is the point: a request
    -- sitting in a lead's queue that they are not yet allowed to decide is
    -- worse than no notification, because the only way to find that out is to
    -- open it and be refused.
    for v_approver in
      select r.reliever_id as user_id
        from vizserve_pms_internal_request_relievers r
       where r.request_id = v_id
    loop
      perform vizserve_pms_notify(
        v_approver.user_id,
        'pending_approval',
        v_name || ' asked you to cover their work',
        v_reason,
        'internal_request',
        v_id,
        '/approvals/' || v_id::text
      );
    end loop;
  else
    -- ⚠️ THE BLOCK P7-16b EXISTS FOR — reproduced verbatim. Rewriting a
    -- function body is how it was lost twice: the type must be
    -- 'pending_approval' (nothing else is in the enum), the recipient
    -- `md.user_id`, and the title "<type> request from <name>".
    --
    -- Everyone who leads the requester's department hears about it. Not one
    -- nominated approver: a queue with a single named owner stalls the moment
    -- that person is on leave, which for a leave-request module is not a corner
    -- case.
    --
    -- The notification says "leave request from X" and NOT which kind. The type
    -- is on the request for the lead who opens it; it does not belong in a title
    -- that may surface on a lock screen. Same instinct as P7-10.
    --
    -- This is now the stage-0 AND stage-2 path — non-reliever leave lands with
    -- the leads exactly as it always did. Only the third stage is new to them,
    -- and they never see it.
    for v_approver in
      select md.user_id
        from vizserve_pms_user_managed_departments md
        join vizserve_pms_users u on u.id = md.user_id
       where md.department_id = v_department
         and u.is_active
         and u.id <> v_user
    loop
      perform vizserve_pms_notify(
        v_approver.user_id,
        'pending_approval',
        replace(p_request_type::text, '_', ' ') || ' request from ' || v_name,
        v_reason,
        'internal_request',
        v_id,
        '/approvals/' || v_id::text
      );
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ⚠️ The eleven-argument version has to go. See the header.
drop function if exists vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid,
  vizserve_pms_day_half, vizserve_pms_day_half
);

grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid,
  vizserve_pms_day_half, vizserve_pms_day_half, jsonb, boolean
) to authenticated;

-- ===========================================================================
-- WITHDRAWAL.
--
-- New. Until now a submitter had NO write path to their own pending request at
-- all — vizserve_pms_internal_requests has no INSERT or UPDATE policy, only a
-- SELECT one, so a mistyped leave request could be undone in exactly one way:
-- ask a lead to reject it. That writes a refusal into the permanent record for
-- a request nobody ever actually refused, and Phase 6 will report it as one.
--
-- DELIBERATELY GENERAL, not leave-only. Nothing about "I filed this by mistake"
-- is specific to leave, and a reimbursement for the wrong amount is the case
-- most likely to need it.
--
-- THE RULE: while nobody has decided. Not "while it is pending" — a leave
-- request whose relievers have all approved is still PENDING_REVIEW, and
-- letting the requester pull it out from under three people who have already
-- signed is exactly the surprise this rule exists to prevent. Once anybody has
-- put their name to it, the way out is a rejection, which is somebody's
-- decision and reads as one.
-- ===========================================================================
create or replace function vizserve_pms_withdraw_internal_request(p_id uuid)
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
  -- only the author can do it.
  if v_req.requester_id <> v_user then
    raise exception 'Only the person who filed a request can withdraw it.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_req.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  -- Both decision logs, because the chain writes to two places: stages 2 and 3
  -- go through vizserve_pms_record_decision into vizserve_pms_approvals, and a
  -- reliever's answer lives on their own row. Checking only the first would let
  -- somebody withdraw a request two of their three relievers had already
  -- accepted.
  if exists (
    select 1 from vizserve_pms_approvals a
     where a.entity_type = 'internal_request' and a.entity_id = p_id
  ) or exists (
    select 1 from vizserve_pms_internal_request_relievers r
     where r.request_id = p_id and r.decision is not null
  ) then
    raise exception 'Somebody has already answered this, so it cannot be withdrawn. Ask them to reject it instead.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_before := to_jsonb(v_req);

  update vizserve_pms_internal_requests
     set status = 'WITHDRAWN'
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, 'withdrawn', v_user, v_before,
    jsonb_build_object('status', 'WITHDRAWN', 'approval_stage', v_req.approval_stage)
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
  -- Two plain loops rather than one clever query. An earlier draft folded them
  -- into a single select with two conditional LEFT JOINs and a CASE on the
  -- join key; it was shorter and nobody reading it could say what it returned
  -- when a request had both relievers and leads.
  --
  -- Stage 3 notifies nobody: a manager is not sitting on a named queue of one,
  -- and mailing every manager in the company that a request they had not yet
  -- looked at has gone away is noise. It cannot arise anyway — reaching stage 3
  -- means two decisions exist, and this function refuses to run at all then.
  if v_req.approval_stage = 1 then
    for v_approver in
      select r.reliever_id as user_id
        from vizserve_pms_internal_request_relievers r
        join vizserve_pms_users u on u.id = r.reliever_id
       where r.request_id = p_id and u.is_active and u.id <> v_user
    loop
      perform vizserve_pms_notify(
        v_approver.user_id, 'internal_decision',
        coalesce(v_name, 'A colleague') || ' withdrew their leave request',
        'You no longer need to cover their work.',
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
        'It no longer needs your approval.',
        'internal_request', p_id, '/approvals/' || p_id::text
      );
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'status', 'WITHDRAWN');
end;
$$;

grant execute on function vizserve_pms_withdraw_internal_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- STILL NOT CHANGED HERE: vizserve_pms_decide_internal_request.
--
-- It does not yet read `approval_stage`, so between this migration and P9-04 a
-- leave request opened at stage 2 is decided in one step exactly as before. The
-- degradation is graceful and in the safe direction — a stage the decider
-- cannot advance is a stage nobody is stuck behind. Apply P9-04 next.
-- ---------------------------------------------------------------------------

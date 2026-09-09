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

    -- P11-11 — ANY ACTIVE COLLEAGUE, NOT ONLY YOUR OWN DEPARTMENT.
    --
    -- This read `and u.primary_department_id = v_department`, and refused with
    -- "Pick a reliever from your own department." Work does not divide that
    -- neatly: the person who can actually hold your accounts for a week is
    -- often the one who already works with you across a line, and a rule that
    -- says otherwise gets satisfied by naming somebody who will not do it.
    --
    -- `is_active` is the whole of the check now. The three other rules on this
    -- block are untouched and are the ones that were doing the real work: at
    -- most three relievers, no duplicates, and one task to one reliever.
    if not exists (
      select 1 from vizserve_pms_users u
       where u.id = v_reliever and u.is_active
    ) then
      raise exception 'That person is not an active account.' using errcode = 'check_violation';
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
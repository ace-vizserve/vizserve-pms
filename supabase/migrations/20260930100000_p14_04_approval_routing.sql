-- P14-04 — APPROVAL ROUTING, HARD-CODED (30 Sep 2026).
--
-- Decided by Ace, and deliberately NOT a configurable builder yet:
--
--   Timesheet                                  -> Manager
--   Leave                                      -> Relievers -> dept Team Leader -> Manager
--   Overtime, DTR corrections, reimbursement   -> dept Team Leader -> Manager
--   A Team Leader's own request                -> skips straight to the Manager
--   The Manager's own request                  -> auto-approved (nobody sits above them)
--   CEO (owner), Business Manager, Admin       -> approve NOTHING
--
-- "Dept Team Leader" = a user whose role IS team_leader and who is assigned the
-- department in vizserve_pms_user_managed_departments. Managers are not
-- department-scoped: a manager has oversight of every department.
--
-- ⚠️ `role = 'team_leader'` AND `role = 'manager'` ARE EQUALITY TESTS ON PURPOSE.
-- D15's "always >=" made the top of the ladder inherit approval authority, which
-- is exactly what CEO/Business Manager/Admin must no longer have. Approval is a
-- job, not a rank. Recorded as D22 alongside the multi-role decision.
--
-- ⚠️ APPLY BY HAND in the SQL editor, AFTER 20260930090000_p14_02a (the enum
-- value). Never `db:push`. Every function below is `create or replace` with an
-- unchanged signature, so existing grants carry over.
--
-- ⚠️ THIS FILE IS NOW THE LIVE DEFINITION of: submit/decide/withdraw internal
-- request, submit/decide/withdraw timesheet week, may_decide_internal_stage,
-- manages_department and can_approve. Re-pasting an older migration silently
-- reinstates the old routing.


-- ===========================================================================
-- 1. WHO IS A LIVE ACCOUNT.
--
-- Active in the app AND not deleted or banned in Supabase Auth. Used for every
-- approver list below, so a person switched off in either place stops being
-- somebody a request can wait on.
-- ===========================================================================
create or replace function vizserve_pms_account_is_live(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_users u
      join auth.users au on au.id = u.id
     where u.id = p_user_id
       and u.is_active
       and 'vizserve-pms' = any(u.app_access)
       and au.deleted_at is null
       and (au.banned_until is null or au.banned_until <= now())
  )
$$;

revoke all on function vizserve_pms_account_is_live(uuid) from public, anon, authenticated;


-- ===========================================================================
-- 2. THE TWO APPROVER POOLS. Every "who approves" and "who is told" question
-- below reads one of these, so the two can never disagree.
-- ===========================================================================
create or replace function vizserve_pms_team_leaders_of(
  p_department_id uuid,
  p_exclude       uuid default null
)
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select md.user_id
    from vizserve_pms_user_managed_departments md
    join vizserve_pms_users u on u.id = md.user_id
   where md.department_id = p_department_id
     and u.role = 'team_leader'
     and md.user_id is distinct from p_exclude
     and vizserve_pms_account_is_live(md.user_id)
$$;

create or replace function vizserve_pms_managers(p_exclude uuid default null)
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.id
    from vizserve_pms_users u
   where u.role = 'manager'
     and u.id is distinct from p_exclude
     and vizserve_pms_account_is_live(u.id)
$$;

revoke all on function vizserve_pms_team_leaders_of(uuid, uuid) from public, anon, authenticated;
revoke all on function vizserve_pms_managers(uuid) from public, anon, authenticated;


-- ===========================================================================
-- 3. WHERE A REQUEST ENTERS THE LEAD CHAIN: 2 (Team Leader) or 3 (Manager).
--
-- Straight to the Manager when the requester leads that department themselves
-- (a Team Leader's own request goes up, not sideways to a peer), or when the
-- department has no other live Team Leader — otherwise it would wait on nobody.
-- ===========================================================================
create or replace function vizserve_pms_first_lead_stage(
  p_department_id uuid,
  p_requester     uuid
)
returns smallint
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case
    when exists (
           select 1 from vizserve_pms_user_managed_departments md
            where md.user_id = p_requester and md.department_id = p_department_id
         )
      or not exists (select 1 from vizserve_pms_team_leaders_of(p_department_id, p_requester))
    then 3::smallint
    else 2::smallint
  end
$$;

revoke all on function vizserve_pms_first_lead_stage(uuid, uuid) from public, anon, authenticated;


-- ===========================================================================
-- 4. WHO A REQUEST IS WAITING ON RIGHT NOW. Reads the stage, not the status, so
-- the withdraw path can still ask it after flipping the status.
-- ===========================================================================
create or replace function vizserve_pms_internal_stage_approvers(p_request_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select r.reliever_id
    from vizserve_pms_internal_requests q
    join vizserve_pms_internal_request_relievers r on r.request_id = q.id
   where q.id = p_request_id and q.approval_stage = 1 and r.decision is null
  union
  select t
    from vizserve_pms_internal_requests q,
         vizserve_pms_team_leaders_of(q.department_id, q.requester_id) t
   where q.id = p_request_id and q.approval_stage = 2
  union
  select m
    from vizserve_pms_internal_requests q,
         vizserve_pms_managers(q.requester_id) m
   where q.id = p_request_id and q.approval_stage = 3
$$;

revoke all on function vizserve_pms_internal_stage_approvers(uuid) from public, anon, authenticated;


-- ===========================================================================
-- 4b. THE MANAGER'S OWN REQUESTS SKIP APPROVAL.
--
-- There is one manager and nobody above them in the approval chain, so their
-- leave, overtime, corrections and timesheets are approved on submission. For
-- leave, relievers still accept the hand-over first — that is consent to cover
-- the work, not an approval — and the request is approved the moment they have.
-- ===========================================================================
create or replace function vizserve_pms_skips_approval(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from vizserve_pms_users u
     where u.id = p_user_id and u.role = 'manager'
  )
$$;

revoke all on function vizserve_pms_skips_approval(uuid) from public, anon, authenticated;

-- P7-39's DTR write-back, lifted out of the decide function UNCHANGED so the
-- auto-approval path runs the same code rather than a second copy of it.
-- Returns null for every type that is not one of the four corrections.
--
-- ⚠️ Assigned, NOT coalesced, and NOT greatest(). This is the one path allowed
-- to move a punch earlier — read P7-39 before "tidying" any of it.
create or replace function vizserve_pms_apply_dtr_correction(p_id uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req       vizserve_pms_internal_requests;
  v_existing  vizserve_pms_dtr_entries;
  v_entry_id  uuid;
  v_fixes_in  boolean;
  v_fixes_out boolean;
begin
  select * into v_req from vizserve_pms_internal_requests where id = p_id;

  v_fixes_in  := v_req.request_type in ('NO_TIME_IN',  'TIME_IN_CORRECTION');
  v_fixes_out := v_req.request_type in ('NO_TIME_OUT', 'TIME_OUT_CORRECTION');

  if not (v_fixes_in or v_fixes_out) then
    return null;
  end if;

  select * into v_existing
    from vizserve_pms_dtr_entries
   where user_id = v_req.requester_id and work_date = v_req.work_date;

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

  insert into vizserve_pms_dtr_entries (
    user_id, work_date, time_in, time_out,
    corrected_by, corrected_at, correction_request_id
  ) values (
    v_req.requester_id,
    v_req.work_date,
    case when v_fixes_in then v_req.correction_at end,
    case when v_fixes_out then v_req.correction_at end,
    p_actor, now(), p_id
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
         corrected_by = p_actor,
         corrected_at = now(),
         correction_request_id = p_id
  returning id into v_entry_id;

  perform vizserve_pms_write_audit_log(
    'dtr_entry', v_entry_id, 'corrected', p_actor,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    jsonb_build_object(
      'request_type', v_req.request_type,
      'work_date', v_req.work_date,
      'correction_at', v_req.correction_at,
      'internal_request_id', p_id
    )
  );

  return v_entry_id;
end;
$$;

revoke all on function vizserve_pms_apply_dtr_correction(uuid, uuid) from public, anon, authenticated;

create or replace function vizserve_pms_auto_approve_internal(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req   vizserve_pms_internal_requests;
  v_entry uuid;
begin
  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  update vizserve_pms_internal_requests
     set status          = 'APPROVED',
         decision_reason = 'Auto-approved: filed by the manager.',
         reviewed_by     = null,
         reviewed_at     = now()
   where id = p_id;

  v_entry := vizserve_pms_apply_dtr_correction(p_id, v_req.requester_id);

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, 'auto_approved', v_req.requester_id, to_jsonb(v_req),
    jsonb_build_object(
      'status', 'APPROVED',
      'reason', 'Filed by the manager — nobody sits above them in the approval chain',
      'dtr_entry_id', v_entry
    )
  );

  return v_entry;
end;
$$;

revoke all on function vizserve_pms_auto_approve_internal(uuid) from public, anon, authenticated;


-- ===========================================================================
-- 5. STAGES ARE NO LONGER LEAVE-ONLY. Every internal type now runs Team
-- Leader -> Manager; only the reliever stage (1) stays leave's own.
-- ===========================================================================
alter table vizserve_pms_internal_requests
  drop constraint if exists vizserve_pms_internal_requests_stage_is_leave;

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_relievers_are_leave
    check (approval_stage <> 1 or request_type = 'LEAVE');


-- ===========================================================================
-- 6. DEPARTMENT SCOPE AND APPROVAL AUTHORITY.
--
-- manages_department is SCOPE (what you can see and work on): the manager now
-- covers every department. The owner branch (is_admin) stays for now — CEO
-- oversight reads go through it — and is removed in the monitoring-only audit.
--
-- can_approve is AUTHORITY (client Gate 1, and the engine's base check): a Team
-- Leader for the departments they are assigned, or the manager. The owner
-- branch is GONE: CEO, Business Manager and Admin approve nothing.
-- ===========================================================================
create or replace function vizserve_pms_manages_department(target_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    vizserve_pms_is_admin()
    or vizserve_pms_current_role() = 'manager'
    or (
      vizserve_pms_has_role('team_leader')
      and target_department_id in (select vizserve_pms_managed_department_ids())
    )
$$;

create or replace function vizserve_pms_can_approve(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    vizserve_pms_current_role() = 'manager'
    or (
      vizserve_pms_current_role() = 'team_leader'
      and p_department_id in (select vizserve_pms_managed_department_ids())
    ),
    false
  )
$$;


-- ===========================================================================
-- 7. WHO MAY DECIDE STAGES 2 AND 3 — read straight off the two pools.
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
     where p_entity_type = 'internal_request'
       and r.id = p_entity_id
       and r.status = 'PENDING_REVIEW'
       and (
         (r.approval_stage = 2
          and auth.uid() in (select vizserve_pms_team_leaders_of(r.department_id, r.requester_id)))
         or
         (r.approval_stage = 3
          and auth.uid() in (select vizserve_pms_managers(r.requester_id)))
       )
  );
$$;


-- ===========================================================================
-- 8. SUBMITTING AN INTERNAL REQUEST.
--
-- p11_11's body verbatim except three edits: the starting stage is computed once
-- into v_stage (relievers -> 1, else first_lead_stage), the audit entry records
-- that same v_stage, and the non-reliever notification goes to whoever the
-- request is actually waiting on.
-- ===========================================================================
create or replace function vizserve_pms_submit_internal_request(
  p_request_type    vizserve_pms_internal_request_type,
  p_reason          text,
  p_start_date      date default null,
  p_end_date        date default null,
  p_work_date       date default null,
  p_correction_time time default null,
  p_amount          numeric default null,
  p_overtime_minutes integer default null,
  p_leave_type_id   uuid default null,
  p_start_half      vizserve_pms_day_half default 'MORNING',
  p_end_half        vizserve_pms_day_half default 'AFTERNOON',
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

    select lt.requires_reliever into v_requires_reliever
      from vizserve_pms_leave_types lt
     where lt.id = p_leave_type_id and lt.is_active;

    if v_requires_reliever is null then
      raise exception 'That leave type is no longer available. Pick one from the list.'
        using errcode = 'check_violation';
    end if;

    if p_start_date = p_end_date and p_start_half > p_end_half then
      raise exception 'Leave on one day cannot start in the afternoon and end in the morning.'
        using errcode = 'check_violation';
    end if;
  end if;

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

    if v_count > 3 then
      raise exception 'Name at most three relievers.' using errcode = 'check_violation';
    end if;

    if not coalesce(p_turnover_confirmed, false) then
      raise exception 'Confirm the turn-over before submitting.' using errcode = 'check_violation';
    end if;
  end if;

  if v_count <> (
    select count(distinct e.value ->> 'reliever_id') from jsonb_array_elements(v_relievers) e
  ) then
    raise exception 'That person is already listed as a reliever.' using errcode = 'check_violation';
  end if;

  if (
    select count(*) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) <> (
    select count(distinct t.value) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) then
    raise exception 'Each task can only go to one reliever.' using errcode = 'check_violation';
  end if;

  -- P14-04. THE ONE EXPRESSION THAT DECIDES THE ROUTE, computed once and used
  -- for the row and its audit entry alike.
  --   relievers named -> 1, the relievers first
  --   otherwise       -> 2 (Team Leader) or 3 (Manager), see first_lead_stage
  v_stage := case
    when coalesce(v_requires_reliever, false) then 1
    else vizserve_pms_first_lead_stage(v_department, v_user)
  end;

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id, start_half, end_half,
    approval_stage, turnover_confirmed_at
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_start_half, 'MORNING') else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_end_half, 'AFTERNOON') else null end,
    v_stage,
    case when v_count > 0 then now() else null end
  )
  returning id into v_id;

  for v_entry in select value as payload from jsonb_array_elements(v_relievers) loop
    v_reliever := nullif(v_entry.payload ->> 'reliever_id', '')::uuid;

    if v_reliever is null then
      raise exception 'Choose a reliever, or remove the empty row.' using errcode = 'check_violation';
    end if;

    if v_reliever = v_user then
      raise exception 'You cannot be your own reliever.' using errcode = 'check_violation';
    end if;

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

    if v_tasks = 0 then
      raise exception 'Give every reliever at least one task.' using errcode = 'check_violation';
    end if;
  end loop;

  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object(
      'request_type', p_request_type,
      'department_id', v_department,
      'approval_stage', v_stage,
      'relievers', v_relievers
    )
  );

  -- P14-04. The manager's own request, with no hand-over to agree first, is
  -- approved now and nobody is asked.
  if v_count = 0 and vizserve_pms_skips_approval(v_user) then
    perform vizserve_pms_auto_approve_internal(v_id);
    return jsonb_build_object('ok', true, 'id', v_id, 'auto_approved', true);
  end if;

  if v_count > 0 then
    -- Stage 1. The leads are not told yet: the relievers answer first.
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
    -- ⚠️ P7-16b's block: type 'pending_approval', title "<type> request from
    -- <name>". P14-04 changes only the RECIPIENTS — whoever the request is
    -- waiting on at the stage it landed on (Team Leaders, or the Manager).
    for v_approver in
      select a as user_id from vizserve_pms_internal_stage_approvers(v_id) a
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


-- ===========================================================================
-- 9. DECIDING AN INTERNAL REQUEST.
--
-- Stage 3 (the manager) is the LAST step for every type now. It is authorised
-- here and then FALLS THROUGH to the single-decision body, which is p9_04's
-- stage-0 body: the engine call, the status, the P7-39 DTR write-back (moved
-- verbatim into vizserve_pms_apply_dtr_correction so auto-approval runs the same
-- code), the audit row and the requester's notification.
--
-- Stages 1 and 2 only ever ADVANCE (1 -> 2 or 3, 2 -> 3) or reject.
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
  v_actor     uuid := auth.uid();
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rejected  boolean := (p_decision = 'rejected');
  v_row       vizserve_pms_internal_request_relievers;
  v_next      smallint;
  v_owed      integer;
  v_person    record;
  v_name      text;
  v_label     text;
begin
  if p_decision = 'returned' then
    raise exception 'Internal requests are approved or rejected, not returned.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_req.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  if v_req.requester_id = v_actor then
    raise exception 'You cannot decide your own request.'
      using errcode = 'insufficient_privilege';
  end if;

  -- =========================================================================
  -- STAGE 3 — the manager. Authorised here; decided by the body at the bottom.
  -- =========================================================================
  if v_req.approval_stage = 3 then
    if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
      raise exception 'This is waiting on the manager.'
        using errcode = 'insufficient_privilege';
    end if;

    -- Two gates, two people: a signature at stage 2 cannot also be stage 3's.
    if exists (
      select 1 from vizserve_pms_approvals a
       where a.entity_type = 'internal_request'
         and a.entity_id = p_id
         and a.approver_id = v_actor
    ) then
      raise exception 'You already approved this at an earlier stage. It needs somebody else.'
        using errcode = 'insufficient_privilege';
    end if;

  -- =========================================================================
  -- STAGES 1 AND 2 — advance or reject, and return from inside.
  -- =========================================================================
  elsif v_req.approval_stage in (1, 2) then
    v_before := to_jsonb(v_req);
    select u.full_name into v_name from vizserve_pms_users u where u.id = v_req.requester_id;

    if v_req.approval_stage = 1 then
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

        if v_owed > 0 then
          return jsonb_build_object(
            'ok', true, 'status', v_req.status::text,
            'approval_stage', 1, 'stage_complete', false, 'dtr_entry_id', null
          );
        end if;
      end if;

      -- P14-04. The manager's own leave: the hand-over was the only thing
      -- anybody had to agree to, so it is approved now.
      if not v_rejected and vizserve_pms_skips_approval(v_req.requester_id) then
        perform vizserve_pms_auto_approve_internal(p_id);
        return jsonb_build_object(
          'ok', true, 'status', 'APPROVED',
          'approval_stage', 1, 'stage_complete', true, 'dtr_entry_id', null
        );
      end if;

      -- P14-04. A Team Leader's own leave skips their peers.
      v_next := vizserve_pms_first_lead_stage(v_req.department_id, v_req.requester_id);

    else
      if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
        raise exception 'This is waiting on a team leader of that department.'
          using errcode = 'insufficient_privilege';
      end if;

      perform vizserve_pms_record_decision(
        'internal_request', p_id, v_req.department_id, p_decision, p_reason
      );

      v_next := 3;
    end if;

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

    update vizserve_pms_internal_requests
       set approval_stage = v_next
     where id = p_id;

    perform vizserve_pms_write_audit_log(
      'internal_request', p_id, 'stage_advanced', v_actor, v_before,
      jsonb_build_object('from_stage', v_req.approval_stage, 'to_stage', v_next)
    );

    v_label := initcap(replace(lower(v_req.request_type::text), '_', ' '));

    -- Whoever it waits on now — Team Leaders at 2, the Manager at 3.
    for v_person in
      select a as user_id from vizserve_pms_internal_stage_approvers(p_id) a
    loop
      perform vizserve_pms_notify(
        v_person.user_id, 'pending_approval',
        case when v_next = 2
             then v_label || ' request from ' || coalesce(v_name, 'a colleague')
             else v_label || ' for final approval: ' || coalesce(v_name, 'a colleague')
        end,
        case when v_req.approval_stage = 1
             then 'The relievers have accepted the hand-over.'
             else 'Approved by their team leader.'
        end,
        'internal_request', p_id, '/approvals/' || p_id::text
      );
    end loop;

    return jsonb_build_object(
      'ok', true, 'status', v_req.status::text,
      'approval_stage', v_next, 'stage_complete', true, 'dtr_entry_id', null
    );
  end if;

  -- =========================================================================
  -- THE FINAL DECISION — stage 3, and any legacy stage-0 row. The p9_04 / P7-39
  -- body, with the DTR write-back moved into vizserve_pms_apply_dtr_correction.
  -- =========================================================================

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

  -- P5-09 / P7-39 — the DTR write-back, shared with the auto-approval path.
  if v_status = 'APPROVED' then
    v_entry_id := vizserve_pms_apply_dtr_correction(p_id, auth.uid());
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


-- ===========================================================================
-- 10. WITHDRAWING AN INTERNAL REQUEST — p11_13 verbatim except the last
-- branch: an unsigned request at stage 2 or 3 tells whoever it was waiting on
-- (Team Leaders or the Manager), not every lead of the department.
-- ===========================================================================
create or replace function vizserve_pms_withdraw_internal_request(
  p_id   uuid,
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
  v_signed   boolean;
  v_today    date := (now() at time zone 'Asia/Manila')::date;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_req.requester_id <> v_user then
    raise exception 'Only the person who filed a request can withdraw it.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_req.status not in ('PENDING_REVIEW', 'APPROVED') then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  v_signed := v_req.status = 'APPROVED'
    or exists (
      select 1 from vizserve_pms_approvals a
       where a.entity_type = 'internal_request' and a.entity_id = p_id
    )
    or exists (
      select 1 from vizserve_pms_internal_request_relievers r
       where r.request_id = p_id and r.decision is not null
    );

  if v_signed then
    if v_req.request_type <> 'LEAVE' then
      raise exception 'Somebody has already answered this, so it cannot be withdrawn. Ask them to reject it instead.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_req.start_date is null or v_req.start_date <= v_today then
      raise exception 'This leave has already started, so it cannot be withdrawn. Ask a team leader to correct the record instead.'
        using errcode = 'invalid_parameter_value';
    end if;

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
      'withdrawn_note', v_note,
      'withdrawn_from', v_req.status::text,
      'was_signed', v_signed
    )
  );

  select u.full_name into v_name from vizserve_pms_users u where u.id = v_user;

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
    -- P14-04. Whoever it was waiting on at its stage.
    for v_approver in
      select a as user_id from vizserve_pms_internal_stage_approvers(p_id) a
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


-- ===========================================================================
-- 11. TIMESHEETS GO STRAIGHT TO THE MANAGER.
--
-- Submit and withdraw: p8_05b / p7_05b verbatim except the recipients.
-- Decide: p7_05 verbatim plus the manager check. can_approve alone would still
-- admit a Team Leader of the department, so the rule is stated here.
-- ===========================================================================
create or replace function vizserve_pms_submit_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_name       text;
  v_week       date;
  v_this_week  date;
  v_total      integer;
  v_existing   vizserve_pms_timesheet_weeks;
  v_id         uuid;
  v_approver   record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  v_week := date_trunc('week', p_week_start)::date;
  v_this_week := date_trunc('week', (now() at time zone 'Asia/Manila')::date)::date;

  if v_week > v_this_week then
    raise exception 'That week has not happened yet.' using errcode = 'check_violation';
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

  perform 1
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6
   for update;

  select coalesce(sum(e.minutes), 0) into v_total
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6;

  if v_total = 0 then
    raise exception 'There is nothing logged in that week to submit.'
      using errcode = 'check_violation';
  end if;

  select * into v_existing
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  if v_existing.id is not null then
    if v_existing.status = 'SUBMITTED' then
      raise exception 'That week is already with the manager.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_existing.status = 'APPROVED' then
      raise exception 'That week has been approved. Ask the manager to send it back if it needs changing.'
        using errcode = 'invalid_parameter_value';
    end if;

    update vizserve_pms_timesheet_weeks
       set status            = 'SUBMITTED',
           submitted_minutes = v_total,
           submitted_at      = now(),
           decision_reason   = null,
           reviewed_by       = null,
           reviewed_at       = null
     where id = v_existing.id;

    v_id := v_existing.id;
  else
    insert into vizserve_pms_timesheet_weeks (
      user_id, week_start, department_id, status, submitted_minutes
    ) values (
      v_user, v_week, v_department, 'SUBMITTED', v_total
    )
    returning id into v_id;
  end if;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_id, 'submitted', v_user, null,
    jsonb_build_object('week_start', v_week, 'minutes', v_total)
  );

  -- P14-04. The manager's own week is approved on submission.
  if vizserve_pms_skips_approval(v_user) then
    update vizserve_pms_timesheet_weeks
       set status = 'APPROVED', reviewed_by = null, reviewed_at = now()
     where id = v_id;

    perform vizserve_pms_write_audit_log(
      'timesheet_week', v_id, 'auto_approved', v_user, null,
      jsonb_build_object('status', 'APPROVED', 'reason', 'Filed by the manager')
    );

    return jsonb_build_object('ok', true, 'id', v_id, 'minutes', v_total, 'auto_approved', true);
  end if;

  -- P14-04. The manager, not the department's leads.
  for v_approver in
    select m as user_id from vizserve_pms_managers(v_user) m
  loop
    perform vizserve_pms_notify(
      v_approver.user_id,
      'pending_approval',
      'Timesheet from ' || v_name,
      'Week of ' || to_char(v_week, 'DD Mon YYYY'),
      'timesheet_week',
      v_id,
      '/timesheet/team?week=' || v_week::text
    );
  end loop;

  return jsonb_build_object('ok', true, 'id', v_id, 'minutes', v_total);
end;
$$;

create or replace function vizserve_pms_withdraw_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     uuid := auth.uid();
  v_week     date;
  v_row      vizserve_pms_timesheet_weeks;
  v_name     text;
  v_approver record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  v_week := date_trunc('week', p_week_start)::date;

  select * into v_row
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  if v_row.id is null then
    raise exception 'That week has not been submitted.' using errcode = 'no_data_found';
  end if;

  -- P14-04. The manager's weeks approve themselves, so nobody could ever send
  -- one back; the manager takes their own back instead.
  if v_row.status = 'APPROVED' and not vizserve_pms_skips_approval(v_user) then
    raise exception 'That week has been approved. Ask the manager to send it back if it needs changing.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_row.status = 'RETURNED' then
    raise exception 'That week is already back with you to edit.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_row.id, 'withdrawn', v_user, to_jsonb(v_row),
    jsonb_build_object('week_start', v_week, 'minutes', v_row.submitted_minutes)
  );

  delete from vizserve_pms_timesheet_weeks where id = v_row.id;

  select u.full_name into v_name from vizserve_pms_users u where u.id = v_user;

  -- P14-04. The manager the submission notified.
  for v_approver in
    select m as user_id from vizserve_pms_managers(v_user) m
  loop
    perform vizserve_pms_notify(
      v_approver.user_id,
      'internal_decision',
      coalesce(v_name, 'A colleague') || ' cancelled their timesheet submission',
      'Week of ' || to_char(v_week, 'DD Mon YYYY') || ' no longer needs your approval. They will resubmit it.',
      'timesheet_week',
      v_row.id,
      '/timesheet/team?week=' || v_week::text
    );
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function vizserve_pms_decide_timesheet_week(
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
  v_week   vizserve_pms_timesheet_weeks;
  v_status vizserve_pms_timesheet_week_status;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_decision = 'rejected' then
    raise exception 'A week of work is approved or sent back to be fixed, not rejected.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- P14-04. The manager approves timesheets — nobody else.
  if auth.uid() is null or auth.uid() not in (select vizserve_pms_managers()) then
    raise exception 'Timesheets are approved by the manager.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_week
    from vizserve_pms_timesheet_weeks
   where id = p_id
   for update;

  if v_week.id is null then
    raise exception 'That timesheet no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_week.status <> 'SUBMITTED' then
    raise exception 'That timesheet has already been decided.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_week.user_id = auth.uid() then
    raise exception 'You cannot approve your own timesheet.'
      using errcode = 'insufficient_privilege';
  end if;

  perform vizserve_pms_record_decision(
    'timesheet_week', p_id, v_week.department_id, p_decision, p_reason
  );

  v_status := case when p_decision = 'approved' then 'APPROVED' else 'RETURNED' end;

  update vizserve_pms_timesheet_weeks
     set status          = v_status,
         decision_reason = v_reason,
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', p_id, lower(v_status::text), auth.uid(),
    to_jsonb(v_week), jsonb_build_object('status', v_status, 'reason', v_reason)
  );

  perform vizserve_pms_notify(
    v_week.user_id,
    'internal_decision',
    case when p_decision = 'approved'
         then 'Timesheet approved'
         else 'Timesheet sent back' end,
    coalesce(v_reason, 'Week of ' || to_char(v_week.week_start, 'DD Mon YYYY')),
    'timesheet_week',
    p_id,
    '/timesheet?week=' || v_week.week_start::text
  );

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;


-- ===========================================================================
-- 12. REQUESTS ALREADY IN FLIGHT.
--
-- Pending stage-0 requests (overtime, corrections, reimbursement, filed under
-- the old one-step rule) and pending stage-2 leave move to where they would
-- start today: the Team Leader, or the Manager when the requester leads the
-- department or has no Team Leader. Anything landing on the Manager is
-- announced to them, since nothing told them before. The manager's own pending
-- requests are auto-approved. Submitted timesheet weeks need no move — they simply wait on the manager now and appear in their queue.
-- ===========================================================================
do $$
declare
  v_row    record;
  v_person record;
  v_name   text;
begin
  for v_row in
    update vizserve_pms_internal_requests q
       set approval_stage = vizserve_pms_first_lead_stage(q.department_id, q.requester_id)
     where q.status = 'PENDING_REVIEW'
       and q.approval_stage in (0, 2)
    returning q.id, q.approval_stage, q.request_type, q.requester_id
  loop
    perform vizserve_pms_write_audit_log(
      'internal_request', v_row.id, 'rerouted', null, null,
      jsonb_build_object('to_stage', v_row.approval_stage, 'reason', 'P14-04 approval routing')
    );

    -- The manager's own pending requests are approved now. A correction that
    -- contradicts the recorded punch stays pending instead of failing the whole
    -- migration.
    if vizserve_pms_skips_approval(v_row.requester_id) then
      begin
        perform vizserve_pms_auto_approve_internal(v_row.id);
      exception when check_violation then
        raise notice 'P14-04: % left pending — %', v_row.id, sqlerrm;
      end;
      continue;
    end if;

    if v_row.approval_stage = 3 then
      select u.full_name into v_name from vizserve_pms_users u where u.id = v_row.requester_id;

      for v_person in
        select m as user_id from vizserve_pms_managers(v_row.requester_id) m
      loop
        perform vizserve_pms_notify(
          v_person.user_id, 'pending_approval',
          initcap(replace(lower(v_row.request_type::text), '_', ' '))
            || ' for final approval: ' || coalesce(v_name, 'a colleague'),
          'Now routed to the manager.',
          'internal_request', v_row.id, '/approvals/' || v_row.id::text
        );
      end loop;
    end if;
  end loop;

  -- The manager's own requests already at the final step were waiting on a
  -- second manager who does not exist.
  for v_row in
    select q.id
      from vizserve_pms_internal_requests q
     where q.status = 'PENDING_REVIEW'
       and q.approval_stage = 3
       and vizserve_pms_skips_approval(q.requester_id)
  loop
    begin
      perform vizserve_pms_auto_approve_internal(v_row.id);
    exception when check_violation then
      raise notice 'P14-04: % left pending — %', v_row.id, sqlerrm;
    end;
  end loop;

  -- ...and the manager's own submitted timesheet weeks.
  update vizserve_pms_timesheet_weeks w
     set status = 'APPROVED', reviewed_by = null, reviewed_at = now()
   where w.status = 'SUBMITTED'
     and vizserve_pms_skips_approval(w.user_id);
end;
$$;

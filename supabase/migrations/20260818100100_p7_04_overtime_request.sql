-- P7-04 — overtime, approved a day at a time.
--
-- The fifth internal request type, and the first one added since the four at
-- launch. It exists because the timesheet needs something to read: a day past
-- eight hours reads as over-logged unless somebody signed off the extra time,
-- and until now there was nothing in the system that could constitute that
-- signature.
--
-- A DAY AND A LENGTH, not a task. The person asking usually does not yet know
-- which task the extra hours will land on, and an evening split across two
-- tasks would otherwise need two requests. The timesheet reads this by date.
--
-- Nothing in the P2-00 approval engine changes. Again.

-- ---------------------------------------------------------------------------
-- How much overtime.
--
-- The 960 ceiling is arithmetic, not taste, and the invariant is worth stating
-- because it is one careless `alter` away from breaking:
--
--   the timesheet's advisory day rule is  480 + approved overtime
--   the timesheet's ENFORCED day cap is   1440  (the day-total trigger)
--   480 + 960                           = 1440
--
-- Any larger ceiling would let an approved overtime request describe a day the
-- database will not accept entries for — an advisory rule contradicting an
-- enforced one, which is how people learn to ignore both.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_internal_requests
  add column overtime_minutes integer;

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_overtime_range
  check (
    overtime_minutes is null
    or (overtime_minutes > 0 and overtime_minutes <= 960)
  );

comment on column vizserve_pms_internal_requests.overtime_minutes is
  'OVERTIME rows only. Capped at 960 so that 480 + this never exceeds the '
  '1440-minute day cap the timesheet trigger enforces.';

-- ---------------------------------------------------------------------------
-- The per-type shape, rewritten — and the `else` is the reason.
--
-- The original constraint ended with:
--
--   else -- NO_TIME_IN / NO_TIME_OUT
--     work_date is not null and correction_at is not null and ...
--
-- which silently swallows ANY value added to the enum later. 'OVERTIME' would
-- have landed in that branch and been forced to carry a `correction_at` it has
-- no use for — a new type that is simply unusable, failing with a message about
-- corrections.
--
-- So the branches are now exhaustive and the fallthrough is `else false`. The
-- next type added to this enum fails loudly at its first insert instead of
-- quietly impersonating a time correction. That is the whole point of this
-- rewrite; the OVERTIME branch is almost incidental.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_internal_requests
  drop constraint vizserve_pms_internal_requests_shape;

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_shape check (
    case request_type
      when 'LEAVE' then
        start_date is not null and end_date is not null
        and end_date >= start_date
        and work_date is null and correction_at is null and amount is null
        and overtime_minutes is null
      when 'REIMBURSEMENT' then
        amount is not null and amount > 0
        and start_date is null and end_date is null
        and work_date is null and correction_at is null
        and overtime_minutes is null
      when 'OVERTIME' then
        work_date is not null and overtime_minutes is not null
        and start_date is null and end_date is null
        and correction_at is null and amount is null
      when 'NO_TIME_IN' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
      when 'NO_TIME_OUT' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- Submission, with the eighth parameter.
--
-- Appended last so the existing seven keep their positions. Everything else in
-- this function is unchanged from 20260804152000.
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
  p_overtime_minutes integer default null
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

  -- Without a department there is nobody to route to. Failing here with a
  -- sentence beats writing an unroutable row that sits in no queue at all.
  if v_department is null then
    raise exception 'You have no department set, so there is nobody to approve this. Ask an admin to set your department.'
      using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'Say why you are requesting this.' using errcode = 'check_violation';
  end if;

  if p_request_type in ('NO_TIME_IN', 'NO_TIME_OUT') then
    if p_work_date is null or p_correction_time is null then
      raise exception 'A correction needs the date and the time it should have been.'
        using errcode = 'check_violation';
    end if;

    -- Composed in app time, then stored as an instant. The DTR stores
    -- timestamptz, and "08:00 on the 3rd" is only meaningful with a zone.
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

    -- "Not in the future" cannot be a CHECK constraint — Postgres requires
    -- immutable expressions there and `today` is not one. It lives here, in
    -- Manila, because a work date is a local calendar day and the server is UTC.
    --
    -- Today itself is allowed: somebody asking at 17:00 for the evening they are
    -- about to work is the ordinary case, and refusing it would push everyone
    -- into filing overtime the morning after.
    if p_work_date > (now() at time zone 'Asia/Manila')::date then
      raise exception 'Pick the day the overtime was or is being worked, not a future one.'
        using errcode = 'check_violation';
    end if;
  end if;

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes
  )
  returning id into v_id;

  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object('request_type', p_request_type, 'department_id', v_department)
  );

  -- Everyone who leads the requester's department hears about it. Not one
  -- nominated approver: a queue with a single named owner stalls the moment
  -- that person is on leave, which for a leave-request module is not a corner
  -- case.
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

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The old seven-argument function has to GO, not just be superseded.
--
-- `create or replace` with a longer argument list does not replace anything —
-- it creates a second function, and both then exist. PostgREST resolves RPC
-- overloads by argument NAME, so a caller sending the original seven matches
-- both signatures and gets an ambiguity error rather than either function.
--
-- Same dance, same reason, as 20260804140000_p2_06_target_list.sql when
-- `vizserve_pms_approve_request` gained `p_list_id`.
-- ---------------------------------------------------------------------------
drop function if exists vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric
);

-- The old grant died with the old function.
grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- `vizserve_pms_decide_internal_request` is deliberately untouched.
--
-- Its DTR side-effect block already tests
-- `request_type in ('NO_TIME_IN','NO_TIME_OUT')`, and `v_req` is declared as the
-- table rowtype, so it picks up `overtime_minutes` for free — including in the
-- `to_jsonb(v_req)` audit payload.
--
-- Approving overtime writes NOTHING anywhere else, on purpose. An approved OT
-- row is a fact that the timesheet and payroll READ. Copying it into the DTR or
-- pre-filling a timesheet entry would create a second source of truth for the
-- same hours, and the two would disagree the first time somebody worked less
-- overtime than they asked for.
--
-- No RLS change either: the existing SELECT policy (requester or department
-- lead) already covers the new column, and a table-level `grant select` reaches
-- columns added later.
-- ---------------------------------------------------------------------------

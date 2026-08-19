-- ---------------------------------------------------------------------------
-- P7-16a — repairing the audit-log call that P7-16 broke.
--
-- ⚠️ EVERY INTERNAL REQUEST SUBMISSION IS CURRENTLY FAILING. Leave,
-- reimbursement, overtime and both time corrections. This is not a half-day
-- bug; the halves are fine and so is the constraint. The submit function raises
-- before it returns, on every type.
--
-- WHAT WENT WRONG, because the shape of this mistake will recur.
--
-- `20260819090000_p7_16_leave_halves.sql` rewrote
-- `vizserve_pms_submit_internal_request` whole, and its own header says:
--
--   "Everything in this body is unchanged from 20260818150000 apart from the
--    two parameters, the LEAVE validation block and the two insert columns."
--
-- That was not true. The audit call was changed too. Every earlier version of
-- this function — p5_05:207, p7_04:193, p7_12:300 — writes six arguments:
--
--   vizserve_pms_write_audit_log(
--     'internal_request', v_id, 'submitted', v_user, null,
--     jsonb_build_object('request_type', p_request_type, 'department_id', v_department)
--   );
--
-- P7-16 shipped four:
--
--   vizserve_pms_write_audit_log(
--     'internal_request', v_id, 'submitted', to_jsonb(p_request_type)
--   );
--
-- The helper's fourth parameter is `p_actor_id uuid` (p0_09:28-35). A jsonb in
-- the actor slot matches no overload, so Postgres answers
-- `42883: function vizserve_pms_write_audit_log(unknown, uuid, unknown, jsonb)
-- does not exist` — and it answers it AFTER the insert, so the request row is
-- rolled back with it and the user sees a function-does-not-exist error where
-- they expected a confirmation.
--
-- WHY NOBODY NOTICED, and this is the part worth keeping:
--
--   PLPGSQL RESOLVES CALLS INSIDE A FUNCTION BODY AT FIRST EXECUTION, NOT AT
--   CREATE TIME.
--
-- The migration applied cleanly. `create or replace function` parses the body
-- but does not resolve the functions it calls, so a call to a signature that has
-- never existed is accepted without a murmur and fails only when somebody
-- submits. Verifying this migration by inspecting the new columns, the enum and
-- the constraint — all of which are correct — proves nothing about the body.
-- The only check that would have caught it is one round trip through the RPC,
-- which is what `tests/db/leave-halves.test.ts` now does.
--
-- THE RULE THIS ESTABLISHES: a migration that rewrites a function body whole
-- must be exercised by CALLING it, not by reading it. "Unchanged apart from X"
-- is a claim about a diff nobody ran; the database will not check it for you and
-- neither will `create or replace`.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- NO DROP, AND NO REGRANT — deliberately, and the difference from P7-16 matters.
--
-- P7-16 had to drop the old function because it was ADDING two parameters, so
-- `create or replace` would have left a second overload live beside it and
-- PostgREST — which resolves by argument name — could route a payload to either.
-- This migration changes no signature at all. `create or replace` therefore
-- replaces the one function that exists, creates no overload, and keeps the
-- EXECUTE grant that a DROP would have taken with it.
--
-- Dropping here would be actively worse: it would need the eleven-argument
-- grant restating, which is one more thing to get wrong while fixing something.
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
  p_end_half        vizserve_pms_day_half default 'AFTERNOON'
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

    if not exists (
      select 1 from vizserve_pms_leave_types lt
       where lt.id = p_leave_type_id and lt.is_active
    ) then
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

  if p_request_type in ('NO_TIME_IN', 'NO_TIME_OUT') then
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

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id, start_half, end_half
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end,
    -- Coerced to null for every other type, exactly as the leave type is: the
    -- constraint would refuse a stray value, but refusing a request because the
    -- client sent a field it had no business sending is a worse error message
    -- than ignoring it.
    case when p_request_type = 'LEAVE' then coalesce(p_start_half, 'MORNING') else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_end_half, 'AFTERNOON') else null end
  )
  returning id into v_id;

  -- ⚠️ THE LINE THIS MIGRATION EXISTS FOR. Six arguments, byte-for-byte what
  -- p5_05, p7_04 and p7_12 all wrote. `v_user` is the ACTOR (fourth), `null` is
  -- the before-image (fifth), and the payload is the after-image (sixth).
  --
  -- The halves are deliberately NOT added to this payload, tempting though it
  -- is while the line is already open. They are on the row, and the decision
  -- audit in `vizserve_pms_decide_internal_request` records `to_jsonb(v_req)` —
  -- the whole rowtype — so both halves are already in the trail at the point
  -- somebody would go looking for them. A repair migration that also changes
  -- behaviour is a repair nobody can revert cleanly.
  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object('request_type', p_request_type, 'department_id', v_department)
  );

  for v_approver in
    select u.id
      from vizserve_pms_users u
      join vizserve_pms_user_managed_departments m on m.user_id = u.id
     where m.department_id = v_department
       and u.is_active
       and u.id <> v_user
  loop
    perform vizserve_pms_notify(
      v_approver.id, 'request_submitted',
      v_name || ' filed a ' || lower(replace(p_request_type::text, '_', ' ')) || ' request',
      coalesce(v_reason, ''),
      'internal_request', v_id, '/approvals/' || v_id::text
    );
  end loop;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The grant is restated anyway, and it is a no-op on a healthy database.
--
-- `create or replace` keeps the existing grant, so this changes nothing if
-- P7-16 was applied in full. It is here for the case where P7-16's paste died
-- part-way — between its DROP and its own regrant — which would leave the
-- function present and unexecutable, a `permission denied for function` that
-- reads nothing like the 42883 above and would send the next person after the
-- wrong bug entirely.
-- ---------------------------------------------------------------------------
grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid,
  vizserve_pms_day_half, vizserve_pms_day_half
) to authenticated;

-- ---------------------------------------------------------------------------
-- P7-16b — restoring the approver notification that P7-16 also rewrote.
--
-- ⚠️ INTERNAL REQUEST SUBMISSION IS STILL FAILING after P7-16a, one statement
-- further down the same function:
--
--   invalid input value for enum vizserve_pms_notification_type: "request_submitted"
--
-- `vizserve_pms_notification_type` holds seven values and that is not one of
-- them: 'pending_approval', 'assigned', 'status_changed', 'qa_requested',
-- 'client_decision' (p0_10:16), 'internal_decision' (p5_05:16) and 'commented'
-- (p7_07:11). Every earlier version of this function sent 'pending_approval'.
--
-- ⚠️ P7-16a WAS AN INCOMPLETE REPAIR, and that is the lesson here rather than
-- the enum value. It fixed the line the error message named and shipped. The
-- error message names the FIRST statement that fails, not the last one that is
-- wrong — and in a function body where several statements were changed without
-- being declared, fixing one only moves the failure. The whole body should have
-- been diffed against p7_12 the first time. It has been now, and this is the
-- complete list of what P7-16 changed beyond what its header admitted:
--
--   1. the audit call, six arguments to four        — repaired in P7-16a
--   2. the approver notification, entire            — repaired here
--
-- There is no third. `diff` of the two bodies with comments stripped now shows
-- only the two new parameters, the single-day LEAVE check and the three insert
-- columns — which is exactly, and only, what P7-16 set out to do.
--
-- WHAT THE NOTIFICATION BLOCK LOST, restated because two of the three are
-- behaviour and not merely a crash:
--
--   * the type       'pending_approval' -> 'request_submitted'. Fatal. It is
--                    also why the loop query was rewritten at the same time,
--                    which is how a one-word change grew to eleven lines.
--   * the title      "leave request from Ana" -> "Ana filed a leave request".
--                    p7_12:310-312 states the phrasing is deliberate. Restored
--                    rather than kept: this is a repair migration, and a repair
--                    that also redesigns a notification is one nobody can
--                    revert cleanly.
--   * the recipient  `md.user_id` -> `u.id`. The two queries select the same
--                    people by the same rules; only the join is turned round.
--                    Restored with the rest so the block matches p7_12 exactly
--                    and the next diff of these two files is empty.
--
-- ADDING 'request_submitted' TO THE ENUM WAS CONSIDERED AND REJECTED. It is the
-- other way to make this error go away, and it is worse for a reason that would
-- not have surfaced for weeks: `vizserve_pms_notify` reads
-- `vizserve_pms_notification_type_settings` for the email switch and wraps it in
-- `coalesce(v_send_email, false)` (p0_10:89-96). A new enum value with no
-- settings row is therefore not an error — it is a notification type whose email
-- is silently and permanently off, which in this app means the leads stop being
-- emailed about pending approvals and nothing anywhere says so.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, and paste this file as it stands
-- at that moment. P7-16a must be applied first; this file supersedes it, so
-- applying only this one is also correct.
-- ---------------------------------------------------------------------------

-- No drop and no regrant, for the reason P7-16a gives: the signature is
-- unchanged, so `create or replace` creates no second overload and keeps the
-- EXECUTE grant that a DROP would take with it.
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

  -- Six arguments. `v_user` is the ACTOR (fourth), `null` the before-image
  -- (fifth), the payload the after-image (sixth). Repaired in P7-16a; restated
  -- here because this file replaces the whole body.
  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object('request_type', p_request_type, 'department_id', v_department)
  );

  -- ⚠️ THE BLOCK THIS MIGRATION EXISTS FOR — restored verbatim from p7_12:313.
  --
  -- Everyone who leads the requester's department hears about it. Not one
  -- nominated approver: a queue with a single named owner stalls the moment
  -- that person is on leave, which for a leave-request module is not a corner
  -- case.
  --
  -- The notification says "leave request from X" and NOT which kind. The type
  -- is on the request for the lead who opens it; it does not belong in a title
  -- that may surface on a lock screen. Same instinct as P7-10.
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

-- A no-op on a healthy database — `create or replace` keeps the existing grant.
-- Restated for the case where P7-16's paste died between its DROP and its own
-- regrant, which leaves the function present and unexecutable: a `permission
-- denied for function` that reads nothing like the two errors above and would
-- send the next person after the wrong bug entirely.
grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid,
  vizserve_pms_day_half, vizserve_pms_day_half
) to authenticated;

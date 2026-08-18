-- ---------------------------------------------------------------------------
-- P7-16 — leave starts and ends on a HALF of a day.
--
-- Today a leave request is two dates, so "the 3rd to the 5th" and "the 3rd
-- afternoon to the 5th morning" are the same record. People take half days
-- constantly and the only way to say so was to write it in the reason, where
-- nothing can count it and the lead approving it has to read prose to find out
-- how long somebody is actually away.
--
-- Two columns and an enum. No balance arithmetic anywhere — this app
-- deliberately tracks no leave balances (see tests/unit/no-leave-balance.test.ts)
-- and this migration does not start. The halves are a statement of WHEN the
-- leave begins and ends, nothing more.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

-- MORNING BEFORE AFTERNOON, and the order is load-bearing rather than
-- alphabetical luck. Postgres compares enum values by declaration order, so
-- `start_half <= end_half` below is a direct comparison with no CASE and no
-- lookup — the same trick the role enum and the priority enum already rely on.
-- Reversing this list silently inverts the single-day rule.
create type vizserve_pms_day_half as enum ('MORNING', 'AFTERNOON');

alter table vizserve_pms_internal_requests
  add column start_half vizserve_pms_day_half,
  add column end_half   vizserve_pms_day_half;

comment on column vizserve_pms_internal_requests.start_half is
  'P7-16. Which half of start_date the leave begins in. MORNING = the whole of that day; AFTERNOON = from midday. LEAVE only.';
comment on column vizserve_pms_internal_requests.end_half is
  'P7-16. Which half of end_date the leave ends in. AFTERNOON = the whole of that day; MORNING = until midday. LEAVE only.';

-- ---------------------------------------------------------------------------
-- The shape constraint, rewritten whole.
--
-- It is dropped and recreated rather than amended because a CHECK cannot be
-- altered in place, and it stays NOT VALID for the reason p7_12 recorded: the
-- rows that predate the leave-type column would fail it, and there is no honest
-- way to backfill facts nobody stated. NOT VALID enforces the rule on every
-- INSERT and UPDATE from here while leaving history alone.
--
-- EXISTING LEAVE ROWS HAVE NULL HALVES and that is why the LEAVE branch does not
-- demand them. Requiring them would make every historical leave request
-- unupdatable — a lead could not approve one — and backfilling MORNING/AFTERNOON
-- would invent a full day for somebody who may have taken a half. The function
-- below always supplies them, so every NEW row has them; the constraint's job
-- here is only to stop a half arriving on a type that has no days at all.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_internal_requests
  drop constraint vizserve_pms_internal_requests_shape;

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_shape check (
    case request_type
      when 'LEAVE' then
        start_date is not null and end_date is not null
        and end_date >= start_date
        -- A one-day request cannot start in the afternoon and end in the
        -- morning. Across two or more days every combination is legal:
        -- afternoon-to-morning is the ordinary "half a day either end" shape.
        and (
          start_half is null or end_half is null
          or start_date < end_date
          or start_half <= end_half
        )
        and work_date is null and correction_at is null and amount is null
        and overtime_minutes is null
        and leave_type_id is not null
      when 'REIMBURSEMENT' then
        amount is not null and amount > 0
        and start_date is null and end_date is null
        and work_date is null and correction_at is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'OVERTIME' then
        work_date is not null and overtime_minutes is not null
        and start_date is null and end_date is null
        and correction_at is null and amount is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'NO_TIME_IN' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'NO_TIME_OUT' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      else false
    end
  ) not valid;

-- ---------------------------------------------------------------------------
-- Submission, with the tenth and eleventh parameters.
--
-- ⚠️ DROP AND REGRANT (trap 3). PostgREST resolves overloads by argument NAME,
-- so `create or replace` with two extra parameters leaves the nine-argument
-- version live beside this one and the API picks whichever matches the payload
-- it was sent — which would mean a request with halves silently routing to the
-- old function and dropping them. The old signature is dropped explicitly and
-- the grant is re-issued at the bottom, because DROP takes the grant with it.
--
-- Everything in this body is unchanged from 20260818150000 apart from the two
-- parameters, the LEAVE validation block and the two insert columns.
-- ---------------------------------------------------------------------------
drop function if exists vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid
);

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

  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', to_jsonb(p_request_type)
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

-- The regrant. DROP took the old one with it, so without this every submission
-- reads `permission denied for function` — which is a GRANT diagnosis, never a
-- policy one.
grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid,
  vizserve_pms_day_half, vizserve_pms_day_half
) to authenticated;

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- `vizserve_pms_leave_calendar` (P7-10) does not learn the halves. It paints
-- WHICH DAYS somebody is away, and a half day is still a day on which they are
-- partly away — a calendar that rendered halves would be making a scheduling
-- claim ("available until midday") that nothing else in this app supports and
-- that nobody asked for. The halves are visible to the requester and to the lead
-- deciding the request, which is where the question is actually asked.
--
-- There is still NO LEAVE BALANCE ANYWHERE, and this migration is the obvious
-- place to have started one. It does not: counting entitlement needs an accrual
-- rule, a carry-over rule and a year boundary, none of which anybody has stated.
-- Half days make the arithmetic look close enough to tempt it — hence this note.
--
-- `vizserve_pms_decide_internal_request` is untouched: `v_req` is the table
-- rowtype, so it picks both new columns up for free, audit payload included.
-- ---------------------------------------------------------------------------

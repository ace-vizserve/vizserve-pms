-- P7-12 — leave types.
--
-- `LEAVE` has been one flat type carrying a date range and free text, so "sick
-- for two days" and "two weeks of vacation" were the same record with different
-- prose. Nothing could count them separately, which made Phase 6 reporting on
-- leave close to useless and made an entitlement question unanswerable.
--
-- A TABLE, NOT AN ENUM, and this is the one place in this schema where that is
-- the right call.
--
-- Every other closed set here is an enum — request types, statuses, roles,
-- priority. Those are STRUCTURAL: adding a request type means new columns, new
-- validation, new UI. A leave type is POLICY DATA. It changes when HR says it
-- changes, it will gain and lose members, and three migrations in this project
-- have already had to be split in two because Postgres forbids using a new enum
-- value in the transaction that adds it (p7_03/p7_04, p7_07/p7_08, and the
-- Phase 5 original). A table pays that cost once and never again, and it can
-- RETIRE a type without orphaning the requests that used it — which an enum
-- cannot do at all.
--
-- The list below is Amier's, supplied 18 Aug 2026. Most of it is Philippine
-- statutory leave rather than company policy, which is the other reason it must
-- be editable: the statutes change on their own schedule and not on ours.
--
-- STILL OUT OF SCOPE: leave BALANCES. Types are a label on a request; balances
-- are entitlement accounting — accrual, carry-over, "how many days do I have
-- left". That was waved off deliberately and is guarded by
-- tests/unit/no-leave-balance.test.ts, which fails the build if an identifier
-- like `leave_balance` or `leave_accrual` appears anywhere. Adding types does
-- not breach that line and must not become the reason to cross it.

-- ---------------------------------------------------------------------------
-- The table.
--
-- `code` is the stable identifier and `label` is what people read. They are
-- separate for the same reason `form_fields.field_key` is immutable while its
-- label is not: renaming "Vacation Leave" to "Annual Leave" must not orphan
-- three years of requests, and it will not, because nothing joins on the label.
-- ---------------------------------------------------------------------------
create table vizserve_pms_leave_types (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  label      text not null,
  -- Retired rather than deleted. A request from 2026 keeps pointing at the type
  -- it was actually filed under even after HR stops offering it — the same
  -- soft-archive rule form fields already follow (R5). The pickers filter on
  -- this; the detail pages do not.
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vizserve_pms_leave_types_code_present check (length(btrim(code)) > 0),
  constraint vizserve_pms_leave_types_label_present check (length(btrim(label)) > 0)
);

create trigger vizserve_pms_leave_types_updated_at
  before update on vizserve_pms_leave_types
  for each row execute function vizserve_pms_set_updated_at();

-- Same shape as vizserve_pms_holidays: every signed-in person reads it, only an
-- admin writes it. A leave type list is not sensitive — it is a dropdown — and
-- a member who cannot read it cannot file a leave request at all.
alter table vizserve_pms_leave_types enable row level security;
revoke all on vizserve_pms_leave_types from anon;

create policy "leave types readable by active users"
  on vizserve_pms_leave_types for select to authenticated
  using (vizserve_pms_current_role() is not null);

create policy "leave types writable by admin"
  on vizserve_pms_leave_types for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- No explicit table grant: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES for `authenticated` and `service_role` on tables created later, so
-- this one inherits. Stated because "permission denied for table" is a GRANT
-- diagnosis and never an RLS one, and the next person to see it should not have
-- to rediscover that.

-- ---------------------------------------------------------------------------
-- Amier's list, 18 Aug 2026.
--
-- `sort_order` is the order it was given in, which is roughly by how often it
-- is used rather than alphabetical — Vacation and Sick are the two most people
-- will ever pick, and an alphabetical list buries Sick under Service Incentive
-- and Solo Parent.
-- ---------------------------------------------------------------------------
insert into vizserve_pms_leave_types (code, label, sort_order) values
  ('VACATION',         'Vacation Leave',           10),
  ('SICK',             'Sick Leave',               20),
  ('SERVICE_INCENTIVE','Service Incentive Leave',  30),
  ('BIRTHDAY',         'Birthday Leave',           40),
  ('MATERNITY',        'Maternity Leave',          50),
  ('PATERNITY',        'Paternity Leave',          60),
  ('SOLO_PARENT',      'Solo Parent Leave',        70),
  ('SPECIAL_WOMEN',    'Special Leave for Women',  80);

-- ---------------------------------------------------------------------------
-- The column on the request.
--
-- `on delete restrict`: a type that has been used cannot be deleted, only
-- deactivated. That is the whole point of `is_active`, and a cascade here would
-- silently rewrite history the first time an admin tidied the list.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_internal_requests
  add column leave_type_id uuid references vizserve_pms_leave_types (id) on delete restrict;

comment on column vizserve_pms_internal_requests.leave_type_id is
  'P7-12. Required on LEAVE, forbidden on every other type — see the shape '
  'constraint. NULL on LEAVE rows that predate this migration: leave filed '
  'before the list existed cannot honestly be assigned a type after the fact.';

create index vizserve_pms_internal_requests_leave_type_idx
  on vizserve_pms_internal_requests (leave_type_id)
  where leave_type_id is not null;

-- ---------------------------------------------------------------------------
-- The shape constraint, rewritten.
--
-- P7-04 already replaced the old `case … else` with explicit branches and
-- `else false`, so this is an edit to the LEAVE branch and a new clause on the
-- other four rather than another `else` to trip over. That earlier change is
-- what makes this one small.
--
-- NOT VALID, and that is deliberate rather than lazy.
--
-- Existing LEAVE rows have no type, because the concept did not exist when they
-- were filed. There is no honest way to backfill them: nobody knows whether a
-- request from last month was vacation or sick, and guessing "VACATION" would
-- write a fact into the record that nobody stated. NOT VALID enforces the rule
-- on every INSERT and every UPDATE from here while leaving history alone.
--
-- Do NOT run `VALIDATE CONSTRAINT` on this later without deciding what to do
-- about those rows first — it will fail, and the failure is the correct answer.
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
        and leave_type_id is not null
      when 'REIMBURSEMENT' then
        amount is not null and amount > 0
        and start_date is null and end_date is null
        and work_date is null and correction_at is null
        and overtime_minutes is null
        and leave_type_id is null
      when 'OVERTIME' then
        work_date is not null and overtime_minutes is not null
        and start_date is null and end_date is null
        and correction_at is null and amount is null
        and leave_type_id is null
      when 'NO_TIME_IN' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
      when 'NO_TIME_OUT' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
      else false
    end
  ) not valid;

-- ---------------------------------------------------------------------------
-- Submission, with the ninth parameter. Appended last, again.
--
-- Everything in this body is unchanged from 20260818100100 apart from the
-- parameter, the LEAVE validation block and the insert column.
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
  p_leave_type_id   uuid default null
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

  -- P7-12. Checked here as well as in the constraint, because the constraint
  -- can only say "not null" — it cannot say "and it must be a type somebody is
  -- still allowed to pick". A retired type stays valid on the rows that already
  -- reference it and must not be selectable for a new one.
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
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    -- Coerced to null for every other type rather than trusted: the constraint
    -- would refuse a stray value, but refusing a request because the client
    -- sent a field it had no business sending is a worse error message than
    -- ignoring it.
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end
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

-- The eight-argument version has to go, for the third time in this project and
-- for the same reason: `create or replace` with a longer list creates a SECOND
-- function, and PostgREST resolves overloads by argument NAME, so a caller
-- sending the old eight matches both and gets an ambiguity error.
drop function if exists vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer
);

grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- `vizserve_pms_leave_calendar` (P7-10) does NOT learn the type, and this is
-- the migration where that would have been easy and wrong.
--
-- That function withholds `reason` because a reason is a medical appointment or
-- a family emergency. Adding the type would undo it at slightly lower
-- resolution: "Sick Leave", "Maternity Leave", "Solo Parent Leave" and
-- "Special Leave for Women" are, respectively, health, pregnancy, family
-- structure and gynaecological information about a named colleague — published
-- to everyone in the company. Four of the eight types in the list above are
-- disclosures in their own right.
--
-- The calendar keeps returning name and dates. The type is visible to the
-- requester and to the lead deciding it, through the ordinary policy on
-- vizserve_pms_internal_requests, and nowhere else.
--
-- `vizserve_pms_decide_internal_request` is also untouched: `v_req` is the
-- table rowtype, so it picks the new column up for free, including in its
-- to_jsonb audit payload.
-- ---------------------------------------------------------------------------

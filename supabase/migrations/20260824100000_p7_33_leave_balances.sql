-- ---------------------------------------------------------------------------
-- P7-33 — LEAVE BALANCES, PER TYPE. This reverses a standing decision.
--
-- Balances were waved off in Phase 5 ("HR counts manually — ang mahalaga lang,
-- may record") and the exclusion was guarded by a build-failing test,
-- tests/unit/no-leave-balance.test.ts, which fails if an identifier like
-- `leave_balance` appears anywhere in app, lib, migrations or scripts. D25
-- restated it, and both P7-12 and P7-16 wrote a paragraph explaining why they
-- were not starting one.
--
-- Amier reversed it on 24 Aug 2026, asking for balances per leave type rather
-- than one pooled number — which is how Philippine statutory leave actually
-- works: Vacation, Sick and Service Incentive are separate entitlements and a
-- single "days left" figure cannot answer a question about any of them.
--
-- THE GUARD TEST IS DELETED IN THE SAME COMMIT AS THIS MIGRATION. That is the
-- instruction the test itself left ("If leave balances are ever genuinely
-- scoped, DELETE THIS FILE as part of that work"), and it is why the deletion
-- is a line in a diff with a reason attached rather than a column that quietly
-- appeared. See D27 in docs/00-README.md.
--
-- ---------------------------------------------------------------------------
-- THE DESIGN CHOICE THAT MAKES THIS SURVIVABLE: NOTHING DECREMENTS.
--
-- The obvious implementation is a counter that goes down when leave is approved
-- and back up when it is cancelled. Do not do that. A stored counter has to be
-- correct after every path that can change a request — approve, reject, an
-- approval reversed, a date edited, a type changed, an account deactivated and
-- reactivated — and the first path anybody forgets leaves a number that is
-- wrong with nothing on screen to say so. Drift in an entitlement figure is the
-- worst kind: it is believed, it is quoted at people, and it is only found when
-- somebody is told they have no leave left.
--
-- So this table stores ONE fact — how many days HR allocated — and usage is
-- COMPUTED from the approved leave requests themselves, every time it is read.
-- The requests are already the record of truth; this makes the balance a view
-- over them rather than a second opinion about them. Rejection, cancellation
-- and edits need no re-credit path because there is nothing to credit back.
--
-- WHAT THIS DELIBERATELY IS NOT: accrual. Nothing here earns days over time,
-- carries them over at year end, or pro-rates them for a mid-year joiner. An
-- admin types a number per type per year, exactly as HR already works it out on
-- paper. If accrual is ever wanted it is a separate piece of work with its own
-- rules stated first, and it belongs on top of this table rather than inside it.
--
-- AND IT DOES NOT BLOCK. A leave request that would take somebody past their
-- allocation still submits and can still be approved; the remaining figure goes
-- negative and says so. Refusing the request would make the app the authority
-- on entitlement, which it is not — HR is, and HR has reasons this schema does
-- not model. The number is there to be looked at while deciding, not to decide.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Is this a day somebody would otherwise have been at work?
--
-- Weekends and the proclaimed holiday list, which is the same rule
-- `vizserve_pms_add_business_days` (P4) already applies — extracted here rather
-- than copied, because two functions that disagree about whether Good Friday is
-- a working day would put a client deadline and a leave balance out of step.
--
-- An empty `vizserve_pms_holidays` degrades to "weekends only", which is wrong
-- but not dangerous: it over-counts leave rather than silently hiding it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_is_working_day(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- 0 = Sunday, 6 = Saturday.
  select p_date is not null
     and extract(dow from p_date) not in (0, 6)
     and not exists (
       select 1 from vizserve_pms_holidays h where h.holiday_date = p_date
     );
$$;

comment on function vizserve_pms_is_working_day(date) is
  'P7-33. Weekends and proclaimed holidays excluded — the same rule '
  'vizserve_pms_add_business_days applies, shared so the two cannot drift.';


-- ---------------------------------------------------------------------------
-- How many days of leave a request actually consumes.
--
-- WORKING DAYS, NOT CALENDAR DAYS. Leave over a long weekend costs the days
-- somebody would have worked; counting the Saturday would charge them for a day
-- they were never going to be in. This is also why the halves below are only
-- deducted when the day they describe is itself a working day: "back for the
-- afternoon" on a Sunday deducts nothing, because the Sunday counted nothing.
--
-- THE HALVES ARE NOT SYMMETRICAL, which is the part that is easy to get wrong
-- and is spelled out in the P7-16 column comments: on the FIRST day, MORNING
-- means the whole day and AFTERNOON means half of it; on the LAST day it is the
-- other way round. Hence a deduction for a start of AFTERNOON and for an end of
-- MORNING, and for neither of the other two.
--
-- A single day lands correctly out of the same arithmetic rather than a special
-- case: MORNING→MORNING is 1 − 0.5 = 0.5, AFTERNOON→AFTERNOON is 1 − 0.5 = 0.5,
-- MORNING→AFTERNOON is a whole day, and AFTERNOON→MORNING is refused outright
-- by the shape constraint P7-16 added.
--
-- NULL halves are the historical shape — every LEAVE row filed before P7-16 has
-- them — and coalesce to the whole-span reading those rows meant at the time.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_leave_days(
  p_start_date date,
  p_end_date   date,
  p_start_half vizserve_pms_day_half default 'MORNING',
  p_end_half   vizserve_pms_day_half default 'AFTERNOON'
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_days  numeric := 0;
  v_date  date;
  v_start vizserve_pms_day_half := coalesce(p_start_half, 'MORNING');
  v_end   vizserve_pms_day_half := coalesce(p_end_half, 'AFTERNOON');
begin
  -- Defensive rather than expected: the shape constraint already refuses these.
  -- Returning zero beats raising, because this runs inside a summary that a
  -- whole page depends on and one malformed historical row must not blank it.
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    return 0;
  end if;

  v_date := p_start_date;
  while v_date <= p_end_date loop
    if vizserve_pms_is_working_day(v_date) then
      v_days := v_days + 1;
    end if;
    v_date := v_date + 1;
  end loop;

  if v_days = 0 then
    return 0;
  end if;

  if v_start = 'AFTERNOON' and vizserve_pms_is_working_day(p_start_date) then
    v_days := v_days - 0.5;
  end if;

  if v_end = 'MORNING' and vizserve_pms_is_working_day(p_end_date) then
    v_days := v_days - 0.5;
  end if;

  -- Cannot go below zero by construction, since each deduction is paired with a
  -- day that was counted. Clamped anyway: a future edit to the rules above
  -- should surface as a wrong number, never as a negative one.
  return greatest(v_days, 0);
end;
$$;

comment on function vizserve_pms_leave_days(date, date, vizserve_pms_day_half, vizserve_pms_day_half) is
  'P7-33. Working days consumed by a leave span, in halves. Weekends and '
  'holidays excluded; a half is only deducted when its own day was counted.';


-- ---------------------------------------------------------------------------
-- The allocation. One row per person, per leave type, per year.
--
-- `balance_year` rather than `year`: `year` is legal as a column name but reads
-- ambiguously next to the `extract(year from …)` two functions below, and this
-- is the one place the two appear in the same query.
--
-- PER YEAR, because Philippine leave entitlement is annual and an allocation
-- without a year cannot answer "how much did they have in 2026" once 2027
-- starts. There is no carry-over: next year's row is a number an admin types,
-- not a remainder this schema calculates. That is the accrual line again.
--
-- NO ROW MEANS ZERO. An admin who has not set an allocation for a type has not
-- said "zero days" — but zero is the honest reading, and the summary function
-- below returns every active type whether or not a row exists so the gap is
-- visible rather than absent.
-- ---------------------------------------------------------------------------
create table vizserve_pms_leave_balances (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references vizserve_pms_users (id) on delete cascade,
  -- `restrict`, matching internal_requests.leave_type_id: a type somebody holds
  -- an allocation against cannot be deleted, only retired via is_active.
  leave_type_id  uuid not null references vizserve_pms_leave_types (id) on delete restrict,
  balance_year   integer not null,
  days_allocated numeric(5, 1) not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One allocation per person per type per year. Without this an admin saving
  -- twice silently doubles somebody's entitlement, and the upsert in
  -- `setLeaveAllocations` needs a conflict target anyway.
  constraint vizserve_pms_leave_balances_one_per_year
    unique (user_id, leave_type_id, balance_year),

  -- Half days, matching what a request can actually consume. 366 is a year, and
  -- an allocation larger than the year it covers is a typo rather than a policy.
  constraint vizserve_pms_leave_balances_days_sane
    check (days_allocated >= 0 and days_allocated <= 366),
  constraint vizserve_pms_leave_balances_half_days
    check (days_allocated * 2 = trunc(days_allocated * 2)),

  -- Wide enough never to be argued with, narrow enough to catch a mistyped year
  -- that would otherwise create an allocation nobody can find.
  constraint vizserve_pms_leave_balances_year_sane
    check (balance_year between 2020 and 2100)
);

create trigger vizserve_pms_leave_balances_updated_at
  before update on vizserve_pms_leave_balances
  for each row execute function vizserve_pms_set_updated_at();

-- The unique constraint's index already serves lookups by user, and by user +
-- type. Reading a whole year across everybody is an admin report that does not
-- exist yet; when it does, it wants (balance_year, user_id) and can add it then.

comment on table vizserve_pms_leave_balances is
  'P7-33. What HR allocated, per person per leave type per year. Usage is NOT '
  'stored — it is computed from approved requests by '
  'vizserve_pms_leave_balance_summary, so nothing here can drift out of step '
  'with the requests it is meant to describe.';


-- ---------------------------------------------------------------------------
-- RLS. Yours, your lead's, or an admin's — and only an admin writes.
--
-- An entitlement figure is not as private as a leave REASON (which is why
-- P7-10 exists at all), but it is not company-wide either: how many sick days a
-- colleague has left is nobody's business but theirs, their lead's and HR's.
-- The read policy therefore looks like the one on internal requests rather than
-- the one on leave types.
--
-- The department comes from a subquery on the subject's own row rather than a
-- column here. Duplicating `department_id` onto this table would be a second
-- copy to keep in step the first time somebody transfers teams.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_leave_balances enable row level security;
revoke all on vizserve_pms_leave_balances from anon;

create policy "leave balances readable by the person, their lead and admins"
  on vizserve_pms_leave_balances for select to authenticated
  using (
    user_id = auth.uid()
    or vizserve_pms_is_admin()
    or exists (
      select 1
        from vizserve_pms_users u
       where u.id = vizserve_pms_leave_balances.user_id
         and vizserve_pms_manages_department(u.primary_department_id)
    )
  );

-- WRITE IS ADMIN ONLY, not lead. A team leader deciding leave and setting the
-- allowance it is measured against is the same person on both sides of the
-- question. HR — which here means admin — owns the number.
create policy "leave balances writable by admin"
  on vizserve_pms_leave_balances for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- No explicit table grant: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES for `authenticated` and `service_role` on tables created later, so
-- this one inherits. Stated because "permission denied for table" is a GRANT
-- diagnosis and never an RLS one.


-- ---------------------------------------------------------------------------
-- The summary: allocated, used and remaining, per type, for one person.
--
-- SECURITY DEFINER WITH AN EXPLICIT AUTHORITY CHECK, not invoker, and the
-- reason is a failure mode rather than convenience. Run as invoker, the usage
-- half of this query reads `vizserve_pms_internal_requests` through RLS — so a
-- caller who cannot see somebody's requests would get `days_used = 0` and a
-- full remaining balance, which is not "access denied", it is a WRONG NUMBER
-- that looks right. A definer function that raises is the honest version of
-- that, and it is the same shape `vizserve_pms_leave_calendar` uses.
--
-- EVERY ACTIVE TYPE IS RETURNED, allocation row or not, so an unset type reads
-- as "0 of 0" rather than vanishing. A RETIRED type appears only if it has
-- history or an allocation — the row stays truthful about leave already taken
-- under it, without cluttering the list with types nobody may pick.
--
-- YEAR ATTRIBUTION IS BY START DATE. Leave running 30 Dec to 2 Jan counts wholly
-- against the year it began in. Splitting it would be more precise and less
-- explicable, and the alternative — a request that appears in two years' figures
-- — is worse than a rule anybody can state in one sentence.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_leave_balance_summary(
  p_user_id uuid default null,
  p_year    integer default null
)
returns table (
  leave_type_id  uuid,
  code           text,
  label          text,
  is_active      boolean,
  days_allocated numeric,
  days_used      numeric,
  days_remaining numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_caller     uuid := auth.uid();
  v_subject    uuid := coalesce(p_user_id, auth.uid());
  -- Manila, not UTC. On 1 January the server is still in December for eight
  -- hours, and defaulting to the wrong year would show everyone last year's
  -- allocation against this year's first request.
  v_year       integer := coalesce(
                  p_year,
                  extract(year from (now() at time zone 'Asia/Manila'))::integer
                );
  v_department uuid;
  v_exists     boolean;
begin
  if v_caller is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select true, u.primary_department_id
    into v_exists, v_department
    from vizserve_pms_users u
   where u.id = v_subject;

  if not coalesce(v_exists, false) then
    raise exception 'That user does not exist.' using errcode = 'no_data_found';
  end if;

  -- Deliberately the same three-way test as the read policy above. Restated
  -- rather than delegated because a definer function bypasses the policy, so
  -- this IS the check — there is nothing underneath it.
  if v_subject <> v_caller
     and not vizserve_pms_is_admin()
     and not vizserve_pms_manages_department(v_department)
  then
    raise exception 'You cannot read that person''s leave balance.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    lt.id,
    lt.code,
    lt.label,
    lt.is_active,
    coalesce(b.days_allocated, 0)::numeric,
    coalesce(taken.used, 0)::numeric,
    (coalesce(b.days_allocated, 0) - coalesce(taken.used, 0))::numeric
  from vizserve_pms_leave_types lt
  left join vizserve_pms_leave_balances b
         on b.leave_type_id = lt.id
        and b.user_id       = v_subject
        and b.balance_year  = v_year
  left join lateral (
    select sum(
             vizserve_pms_leave_days(r.start_date, r.end_date, r.start_half, r.end_half)
           ) as used
      from vizserve_pms_internal_requests r
     where r.request_type  = 'LEAVE'
       -- APPROVED ONLY. A pending request is not yet a fact, and deducting it
       -- would tell somebody they have less leave than they do on the strength
       -- of a decision nobody has made. The filing dialog shows the pending
       -- count separately if it ever needs to.
       and r.status        = 'APPROVED'
       and r.requester_id  = v_subject
       and r.leave_type_id = lt.id
       and extract(year from r.start_date) = v_year
  ) taken on true
  -- A retired type with nothing behind it is noise; one with history is not.
  where lt.is_active
     or coalesce(b.days_allocated, 0) > 0
     or coalesce(taken.used, 0) > 0
  order by lt.sort_order, lt.label;
end;
$$;

-- `anon` is not granted: this is staff-facing, and the public form and the Gate
-- 3 approval page have no business knowing anybody's entitlement.
revoke all on function vizserve_pms_leave_balance_summary(uuid, integer) from public, anon;
grant execute on function vizserve_pms_leave_balance_summary(uuid, integer) to authenticated;

comment on function vizserve_pms_leave_balance_summary(uuid, integer) is
  'P7-33. Allocated / used / remaining per leave type for one person in one '
  'year. SECURITY DEFINER with its own authority check, because run as invoker '
  'an unauthorised caller would read days_used = 0 rather than an error — a '
  'wrong number that looks right.';


-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- `vizserve_pms_leave_calendar` (P7-10) does not learn about balances, for the
-- same reason P7-12 kept the leave TYPE out of it: the calendar is published to
-- everyone, and "3 sick days remaining" is health information about a named
-- colleague. Balances travel through the summary function above, which asks who
-- is calling.
--
-- `vizserve_pms_submit_internal_request` is untouched. It does not check the
-- balance before accepting a request, because this app is not the authority on
-- entitlement — see the header. A request that overdraws submits, approves, and
-- shows a negative remaining figure to the three people entitled to see it.
--
-- `vizserve_pms_decide_internal_request` is untouched and does not need to be:
-- usage is computed from `status = 'APPROVED'`, so approving a request changes
-- the balance by changing the fact the balance is derived from. That is the
-- whole point of not storing a counter.
-- ---------------------------------------------------------------------------

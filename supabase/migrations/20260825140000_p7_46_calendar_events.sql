-- ---------------------------------------------------------------------------
-- P7-46 — calendar events: company-wide, management, and per department.
--
-- Amier, 25 Aug 2026. THIS IS NOT A HOLIDAY, and the distinction is the whole
-- design. `vizserve_pms_holidays` says "nobody is scheduled to work", which is
-- why two functions consult it to decide how many working days a leave request
-- consumes and when a client deadline falls. An EVENT says "this is happening" —
-- a town hall, a management offsite, a team lunch — and people are working
-- through it. Nothing about this table feeds `vizserve_pms_is_working_day`,
-- `vizserve_pms_leave_days` or `vizserve_pms_add_business_days`, and nothing
-- ever should.
--
-- Putting them in one table with a "counts as a day off" flag was the obvious
-- shortcut and is refused for that reason: the flag would be read wrong exactly
-- once, and the symptom would be everybody's leave balance quietly changing.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

-- ENUM, NOT A TABLE, and this is the other side of the P7-12 argument. Leave
-- types are policy data that HR edits, so they are a table. These three are
-- STRUCTURAL: `DEPARTMENT` is the only one that carries a department_id, the
-- shape constraint below branches on that, and the calendar paints one colour
-- per member. Adding a fourth means new columns and new UI, which is exactly
-- the test P7-12 set for "should this be an enum".
create type vizserve_pms_event_category as enum ('COMPANY', 'MANAGEMENT', 'DEPARTMENT');

create table vizserve_pms_events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  -- Optional. A title is enough for "Christmas party"; a description is for the
  -- one event a year that needs a venue and a time in it.
  description   text,
  category      vizserve_pms_event_category not null,
  -- Set on DEPARTMENT, null on the other two. `on delete cascade`: a department
  -- that no longer exists cannot have events, and an orphan here would render
  -- on the calendar with no owner.
  department_id uuid references vizserve_pms_departments (id) on delete cascade,
  start_date    date not null,
  end_date      date not null,
  -- Who entered it. `on delete set null` rather than cascade: an event does not
  -- disappear because the admin who created it left.
  created_by    uuid references vizserve_pms_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint vizserve_pms_events_title_present check (length(btrim(title)) > 0),

  -- A single-day event is start = end, which is why this is >= and not >.
  constraint vizserve_pms_events_dates_ordered check (end_date >= start_date),

  -- The shape rule, written as explicit branches with no `else` to fall through
  -- — the same discipline P7-04 imposed on the internal-request constraint after
  -- an `else true` silently accepted a malformed row.
  constraint vizserve_pms_events_shape check (
    case category
      when 'DEPARTMENT' then department_id is not null
      when 'COMPANY'    then department_id is null
      when 'MANAGEMENT' then department_id is null
      else false
    end
  )
);

-- The calendar asks for a window: "every event overlapping these six weeks".
-- Both columns, because an event running across the window's start is found by
-- its end_date and one across the finish by its start_date.
create index vizserve_pms_events_range_idx on vizserve_pms_events (start_date, end_date);
create index vizserve_pms_events_department_idx
  on vizserve_pms_events (department_id)
  where department_id is not null;

create trigger vizserve_pms_events_updated_at
  before update on vizserve_pms_events
  for each row execute function vizserve_pms_set_updated_at();

comment on table vizserve_pms_events is
  'P7-46. Things happening, NOT days off. Deliberately separate from '
  'vizserve_pms_holidays: nothing here feeds working-day arithmetic, so an '
  'event can never change a leave balance or a client deadline.';

-- ---------------------------------------------------------------------------
-- RLS: everyone reads, admin writes.
--
-- READABLE BY EVERY ACTIVE USER, INCLUDING OTHER DEPARTMENTS' EVENTS, and that
-- is deliberate rather than an oversight. This is a shared company calendar and
-- an event is not private the way a leave REASON is — "VizMedia team lunch" on
-- Thursday is exactly what a colleague in VizBytes wants to see when they are
-- wondering why nobody is answering. Scoping department events to their own
-- department would make the calendar answer a different question for every
-- person looking at it, which is not a shared calendar at all.
--
-- If an event ever needs to be private, that is a new column and a new policy,
-- and it should be argued for on its own rather than assumed here.
--
-- ADMIN WRITES, decided 25 Aug. The alternative — leads managing their own
-- department's events — was considered and set aside: this calendar is read by
-- everybody, and one admin entering things is the cheapest way to keep it from
-- filling with noise. The `created_by` column is already here if that changes.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_events enable row level security;
revoke all on vizserve_pms_events from anon;

create policy "events readable by active users"
  on vizserve_pms_events for select to authenticated
  using (vizserve_pms_current_role() is not null);

create policy "events writable by admin"
  on vizserve_pms_events for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- No explicit table grant: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES for `authenticated` and `service_role` on tables created later, so
-- this one inherits. Stated because "permission denied for table" is a GRANT
-- diagnosis and never an RLS one.

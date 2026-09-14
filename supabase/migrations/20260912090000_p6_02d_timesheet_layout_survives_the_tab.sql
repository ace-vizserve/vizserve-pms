-- ---------------------------------------------------------------------------
-- P6-02d — the week's LAYOUT, kept in the database instead of the tab.
--
-- P6-02/02b/02c put three things in web storage: the task rows somebody added
-- to a week that have no hours yet (sessionStorage), the order those rows sit
-- in (localStorage), and whether "Last week's tasks" has already been offered
-- (sessionStorage). The first and third die with the tab. So the reported bug
-- is: set your week up with five + Add task presses, close the tab, come back,
-- and there is nowhere left to type.
--
-- ⚠️ THIS IS NOT A DRAFT TIMESHEET AND MUST NEVER BECOME ONE. P7-05's decision
-- stands: `vizserve_pms_timesheet_weeks` has no DRAFT status because the
-- absence of a row IS the draft state, and P7-05b deletes the row to cancel a
-- submission for exactly that reason. Nothing here records hours, minutes, or
-- an intention to submit. It records WHICH ROWS THE GRID DRAWS — a UI
-- arrangement, and the only thing in the timesheet that was ever kept in the
-- browser. Hours have always gone straight to `vizserve_pms_timesheet_entries`
-- on blur and still do.
--
-- ONE ROW PER PERSON PER WEEK, holding all three facts together. The obvious
-- alternative — a child table, one row per added task — buys a foreign key and
-- costs a delete/insert dance on every drag. This shape makes the whole layout
-- a single upsert whatever changed in the burst, which is what lets the client
-- coalesce a five-row drag into one write. The unique constraint below is what
-- makes that upsert expressible at all; the entries table deliberately has no
-- natural key (see 20260817090000_p6_01_timesheet.sql), which is the other
-- reason this is its own table rather than columns on something existing.
--
-- IDS, NOT TASK SNAPSHOTS. The sessionStorage payload stored the whole task —
-- title, status, "Department / List" — because the client could not resolve an
-- id outside the picker's first twenty. The server can, through the same
-- `vizserve_pms_is_on_task` scoping the picker uses, so a stored id that has
-- left somebody's scope drops its row instead of leaving a stale name on it.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor. After P7-05b.
-- ---------------------------------------------------------------------------

create table if not exists vizserve_pms_timesheet_layouts (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references vizserve_pms_users (id) on delete cascade,

  -- The Monday. Same key the grid, the weeks table and the submit function all
  -- use, so a layout and a submission cannot disagree about which week is meant.
  week_start date not null,

  -- Tasks put on the week that have no hours yet — the empty rows. A task that
  -- gains hours is NOT removed from here: deleting its last entry has to bring
  -- the row back, which is what web storage did and what people expect.
  extra_task_ids uuid[] not null default '{}',

  -- The arrangement, by task id. Covers EVERY row including logged ones, so it
  -- is a separate list rather than an ordering of the column above. Empty means
  -- alphabetical, which is what the grid did before anybody could drag anything.
  row_order uuid[] not null default '{}',

  -- P6-02b — the shortcut retires itself once pressed, so it cannot offer, on
  -- its own, the one task somebody just took off the week.
  copied_last_week boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- What makes `on conflict (user_id, week_start)` legal, and what stops two
  -- tabs creating two layouts for one week that then take turns winning.
  constraint vizserve_pms_timesheet_layouts_one_per_week
    unique (user_id, week_start),

  -- The same Monday check the weeks table carries. A layout keyed to a Tuesday
  -- is one nothing will ever read.
  constraint vizserve_pms_timesheet_layouts_monday
    check (extract(isodow from week_start) = 1),

  -- A typo guard, not a policy claim. Nobody has a hundred tasks in one week;
  -- a client bug that appends in a loop should be refused rather than obeyed.
  --
  -- ⚠️ THE FIRST BOUND IS ALSO A URL BUDGET. `loadLoggableTasksByIds` resolves
  -- these ids through `id.in.(…)`, which is the shape the header of
  -- lib/timesheet-tasks-server.ts warns about at length: an unbounded list of
  -- 37-byte uuids outgrows what the client will send, and it fails as
  -- `TypeError: fetch failed` rather than a tidy 414. A hundred is ~3.7 KB and
  -- is what makes that call safe to write at all.
  constraint vizserve_pms_timesheet_layouts_rows_bounded
    check (cardinality(extra_task_ids) <= 100 and cardinality(row_order) <= 200)
);

comment on table vizserve_pms_timesheet_layouts is
  'P6-02d. One row per person per week: which empty task rows the grid draws, '
  'what order the rows sit in, and whether the last-week shortcut has been '
  'used. UI arrangement only — it is NOT a draft timesheet and holds no hours. '
  'Replaces three web-storage keys that died with the tab.';

drop trigger if exists vizserve_pms_timesheet_layouts_updated_at
  on vizserve_pms_timesheet_layouts;

create trigger vizserve_pms_timesheet_layouts_updated_at
  before update on vizserve_pms_timesheet_layouts
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- ⚠️ `enable row level security` IS LOAD-BEARING AND ITS ABSENCE IS SILENT.
--
-- 20260729110000_p0_06_grants.sql sets ALTER DEFAULT PRIVILEGES granting full
-- DML on later tables to `authenticated`, so this table arrives writable by
-- every signed-in user. RLS is the only gate. There is no "permission denied"
-- to go looking for if this line is missed.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_timesheet_layouts enable row level security;
revoke all on vizserve_pms_timesheet_layouts from anon;

-- ---------------------------------------------------------------------------
-- OWNER ONLY, ALL FOUR VERBS — and a lead deliberately gets nothing.
--
-- Every other timesheet table lets a department lead read their team's rows,
-- because hours are a thing a lead decides on. An arrangement is not: nobody
-- approves the order somebody drags their rows into, and /timesheet/team never
-- asks for it. A policy nothing reads is a policy nobody maintains.
--
-- NO WEEK-LOCK CHECK EITHER, unlike the entries policies. Writing layout on a
-- submitted week changes no hours and decides nothing; refusing it would put an
-- error toast on a screen whose whole message is that it is read-only.
--
-- ⚠️ The names below must match the `drop` lines exactly. A misspelled drop
-- leaves the old policy alive, OR-ed with the new one.
-- ---------------------------------------------------------------------------
drop policy if exists "timesheet layout readable by owner"
  on vizserve_pms_timesheet_layouts;
drop policy if exists "timesheet layout insertable by owner"
  on vizserve_pms_timesheet_layouts;
drop policy if exists "timesheet layout updatable by owner"
  on vizserve_pms_timesheet_layouts;
drop policy if exists "timesheet layout deletable by owner"
  on vizserve_pms_timesheet_layouts;

create policy "timesheet layout readable by owner"
  on vizserve_pms_timesheet_layouts for select to authenticated
  using (user_id = (select auth.uid()));

create policy "timesheet layout insertable by owner"
  on vizserve_pms_timesheet_layouts for insert to authenticated
  with check (user_id = (select auth.uid()));

-- The USING half is load-bearing on an upsert: PostgREST's ON CONFLICT DO
-- UPDATE reaches an existing row through this, and without it a second save of
-- the same week is refused as success-with-zero-rows.
create policy "timesheet layout updatable by owner"
  on vizserve_pms_timesheet_layouts for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "timesheet layout deletable by owner"
  on vizserve_pms_timesheet_layouts for delete to authenticated
  using (user_id = (select auth.uid()));

-- Inherited from p0_06's ALTER DEFAULT PRIVILEGES, written out anyway so the
-- grant and the policies sit in one file. Both gates, visible together.
grant select, insert, update, delete on vizserve_pms_timesheet_layouts to authenticated;

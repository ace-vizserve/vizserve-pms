-- P15-10 — RECURRING TASKS (5 Oct 2026).
--
-- THE CASE: the daily huddle, the weekly meeting, the monthly finance close.
-- Today somebody either re-creates the task every period, so the list grows
-- with duplicates, or reuses one task forever, so its tracked time runs past
-- the estimate (5h estimated, 11h tracked) and last week's work is
-- indistinguishable from this week's.
--
-- THE MODEL: a SERIES holds the rule; every period gets a NEW TASK — an
-- instance — copied from the latest one. ClickUp's recurring tasks are the
-- reference (D21), not a system this talks to.
--
--   * When a new period starts, the previous instance is CLOSED (COMPLETED)
--     if it is still open, and a new one is created with the period's dates,
--     the same title, description, people, list, priority and estimate, an
--     unticked checklist, and nothing tracked — tracked time is a sum of the
--     instance's own timesheet entries (P7-15), so a new task starts at zero
--     and the old one keeps its hours. NO timesheet code changes.
--   * Copied from the LATEST instance, not a frozen template, so renaming or
--     re-estimating this week's copy carries into next week's.
--   * Schedule-based: the next copy is made when its period starts, whether or
--     not the last one was finished. No backfill: a missed run makes only the
--     current period's copy, never a pile of past ones.
--   * DAILY means working days (`vizserve_pms_is_working_day`, D31's table).
--     WEEKLY periods start on Monday; MONTHLY on the 1st. Dates keep their
--     place in the period: Mon–Fri stays Mon–Fri, the 15th stays the 15th.
--   * INTERNAL AND PERSONAL TASKS ONLY, top-level only. A client-request task
--     has one request and three gates; a "next week's copy" of it is not a
--     thing. A subtask belongs to its parent's cycle.
--
-- ⚠️ IDEMPOTENT BY CONSTRAINT, NOT BY CARE. `(series_id, series_period_start)`
-- is unique, and the generator inserts `on conflict do nothing`. The cron can
-- run twice, overlap itself, or be called by hand — one copy per period.
--
-- ⚠️ APPLY BY HAND in the SQL editor, as `postgres`, after p15_04. Never
-- `db:push`.

-- ---------------------------------------------------------------------------
-- The rule.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'vizserve_pms_recurrence_frequency') then
    create type vizserve_pms_recurrence_frequency as enum ('DAILY', 'WEEKLY', 'MONTHLY');
  end if;
end;
$$;

create table if not exists vizserve_pms_task_series (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references vizserve_pms_departments (id) on delete restrict,
  frequency      vizserve_pms_recurrence_frequency not null,
  -- Where a new copy starts. OPEN or ONGOING only: a copy born "For QA" or
  -- "Completed" would claim work that has not happened.
  landing_status vizserve_pms_task_status not null default 'ONGOING'
                 check (landing_status in ('OPEN', 'ONGOING')),
  is_active      boolean not null default true,
  created_by     uuid references vizserve_pms_users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  stopped_at     timestamptz,
  stopped_by     uuid references vizserve_pms_users (id) on delete set null
);

comment on table vizserve_pms_task_series is
  'P15-10. A recurring task''s rule. Instances are rows in vizserve_pms_tasks '
  'with series_id set; the generator copies the latest one each period.';

alter table vizserve_pms_task_series enable row level security;
revoke all on vizserve_pms_task_series from anon;
-- Read only, and only where one of its instances is readable. Every write goes
-- through the functions below.
grant select on vizserve_pms_task_series to authenticated;
grant all on vizserve_pms_task_series to service_role;

-- ---------------------------------------------------------------------------
-- The link from an instance to its series.
--
-- ⚠️ NEITHER COLUMN JOINS THE UPDATE GRANT. Moving a task into or out of a
-- series is `vizserve_pms_set_task_recurrence` / `..._stop_...`, which check
-- the task's kind; a direct UPDATE would let a client-request task acquire a
-- schedule.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_tasks
  add column if not exists series_id uuid references vizserve_pms_task_series (id) on delete set null,
  add column if not exists series_period_start date;

create unique index if not exists vizserve_pms_tasks_series_period_unique
  on vizserve_pms_tasks (series_id, series_period_start)
  where series_id is not null;

comment on column vizserve_pms_tasks.series_id is
  'P15-10. The recurring series this task is an instance of, or null.';
comment on column vizserve_pms_tasks.series_period_start is
  'P15-10. The first day of the period this instance covers (the day, the '
  'Monday, or the 1st). Unique per series: the idempotency key.';

-- The series' read policy, HERE and not beside its table: it reads
-- `vizserve_pms_tasks.series_id`, which does not exist until the ALTER above.
-- (The first run of this file failed on exactly that, and rolled back whole.)
drop policy if exists "series readable through their tasks" on vizserve_pms_task_series;
create policy "series readable through their tasks"
  on vizserve_pms_task_series for select to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.series_id = vizserve_pms_task_series.id));

-- ---------------------------------------------------------------------------
-- Period arithmetic. IMMUTABLE and tiny, mirrored in lib/recurrence.ts so the
-- UI can preview "next copy: 12–16 Oct" and the tests can pin both.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_period_start(p_frequency vizserve_pms_recurrence_frequency, p_date date)
returns date
language sql
immutable
as $$
  select case p_frequency
    when 'DAILY' then p_date
    -- ISO weeks start on Monday, which is what `date_trunc('week')` returns.
    when 'WEEKLY' then date_trunc('week', p_date)::date
    else date_trunc('month', p_date)::date
  end;
$$;

/*
 * A date moved from one period into another, keeping its place in it.
 *
 * DAILY and WEEKLY move by the whole-day distance between the period starts.
 * MONTHLY moves by whole months, and Postgres clamps `+ interval` to the end
 * of a short month — the 31st becomes the 30th, not the 1st of the next.
 */
create or replace function vizserve_pms_shift_into_period(
  p_frequency vizserve_pms_recurrence_frequency,
  p_date date,
  p_from_period date,
  p_to_period date
)
returns date
language sql
immutable
as $$
  select case
    when p_date is null then null
    when p_frequency = 'MONTHLY' then
      (p_date + make_interval(months =>
         ((extract(year from p_to_period) - extract(year from p_from_period)) * 12
          + extract(month from p_to_period) - extract(month from p_from_period))::int))::date
    else p_date + (p_to_period - p_from_period)
  end;
$$;

grant execute on function vizserve_pms_period_start(vizserve_pms_recurrence_frequency, date) to authenticated, service_role;
grant execute on function vizserve_pms_shift_into_period(vizserve_pms_recurrence_frequency, date, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Who may set or stop a schedule: whoever may change the task. The same test
-- `vizserve_pms_add_task_assignee` restates (P11-06, P13-01) — on the task, a
-- lead of its department, an active member of it, or the shared space.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_may_change_task(p_task vizserve_pms_tasks, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p_actor is not null and (
    coalesce(vizserve_pms_is_on_task(p_task.id, p_actor), false)
    or coalesce(vizserve_pms_manages_department(p_task.department_id), false)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = p_actor and u.is_active and u.primary_department_id = p_task.department_id
    )
    or coalesce(vizserve_pms_may_collaborate(p_task.department_id), false)
  );
$$;

revoke all on function vizserve_pms_may_change_task(vizserve_pms_tasks, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Set (or change, or restart) a task's schedule.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_set_task_recurrence(
  p_task_id uuid,
  p_frequency vizserve_pms_recurrence_frequency,
  p_landing_status vizserve_pms_task_status default 'ONGOING'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor  uuid := auth.uid();
  v_task   vizserve_pms_tasks;
  v_series uuid;
  v_anchor date;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  if not vizserve_pms_may_change_task(v_task, v_actor) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  if v_task.request_id is not null then
    raise exception 'A client request''s task cannot repeat.' using errcode = 'check_violation';
  end if;

  if v_task.parent_task_id is not null then
    raise exception 'A subtask cannot repeat on its own. Set the schedule on its parent.'
      using errcode = 'check_violation';
  end if;

  if p_landing_status not in ('OPEN', 'ONGOING') then
    raise exception 'A new copy can start as Open or Ongoing.' using errcode = 'check_violation';
  end if;

  -- The period this task covers: its start date, else its due date, else today
  -- in Manila. `now() at time zone` — the database runs in UTC, and 1 a.m.
  -- Monday in Manila is still Sunday there.
  v_anchor := vizserve_pms_period_start(
    p_frequency,
    coalesce(v_task.start_date, v_task.due_date, (now() at time zone 'Asia/Manila')::date)
  );

  if v_task.series_id is null then
    insert into vizserve_pms_task_series (department_id, frequency, landing_status, created_by)
    values (v_task.department_id, p_frequency, p_landing_status, v_actor)
    returning id into v_series;

    update vizserve_pms_tasks
       set series_id = v_series, series_period_start = v_anchor
     where id = p_task_id;
  else
    v_series := v_task.series_id;

    update vizserve_pms_task_series
       set frequency = p_frequency,
           landing_status = p_landing_status,
           is_active = true,
           stopped_at = null,
           stopped_by = null,
           updated_at = now()
     where id = v_series;

    -- A changed frequency re-reads which period THIS copy covers, so the next
    -- one is a day, a week or a month after it under the new rule.
    begin
      update vizserve_pms_tasks set series_period_start = v_anchor where id = p_task_id;
    exception when unique_violation then
      raise exception 'Another copy of this task already covers that period. Change this copy''s dates first.'
        using errcode = 'check_violation';
    end;
  end if;

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'recurrence_set', v_actor, null,
    jsonb_build_object('series_id', v_series, 'frequency', p_frequency, 'landing_status', p_landing_status)
  );

  return v_series;
end;
$$;

grant execute on function vizserve_pms_set_task_recurrence(uuid, vizserve_pms_recurrence_frequency, vizserve_pms_task_status) to authenticated;

-- ---------------------------------------------------------------------------
-- Stop. Past and current copies are untouched — they are work that happened,
-- or is happening — and the series stays, so their link to each other does.
-- Setting a schedule again restarts the same series.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_stop_task_recurrence(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_task  vizserve_pms_tasks;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  if not vizserve_pms_may_change_task(v_task, v_actor) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  if v_task.series_id is null then
    return;
  end if;

  update vizserve_pms_task_series
     set is_active = false, stopped_at = now(), stopped_by = v_actor, updated_at = now()
   where id = v_task.series_id and is_active;

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'recurrence_stopped', v_actor, null,
    jsonb_build_object('series_id', v_task.series_id)
  );
end;
$$;

grant execute on function vizserve_pms_stop_task_recurrence(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The generator. Called once a day by /api/cron/recurring-tasks as the
-- service role; never by a person.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_generate_recurring_tasks(p_today date)
returns table (series_id uuid, task_id uuid, closed_count integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
-- ^ The OUT columns share names with real columns (`series_id`, `task_id`);
-- inside SQL statements here, a bare name always means the column.
declare
  v_series  vizserve_pms_task_series;
  v_latest  vizserve_pms_tasks;
  v_period  date;
  v_new     uuid;
  v_closed  integer;
  v_row     record;
begin
  for v_series in
    select * from vizserve_pms_task_series s where s.is_active order by s.created_at
  loop
    -- A daily series has no copy on a weekend or a holiday.
    if v_series.frequency = 'DAILY' and not vizserve_pms_is_working_day(p_today) then
      continue;
    end if;

    v_period := vizserve_pms_period_start(v_series.frequency, p_today);

    select * into v_latest
      from vizserve_pms_tasks t
     where t.series_id = v_series.id
     order by t.series_period_start desc nulls last, t.created_at desc
     limit 1;

    -- Every copy deleted: nothing left to copy from, so the series ends.
    if v_latest.id is null then
      update vizserve_pms_task_series set is_active = false, stopped_at = now(), updated_at = now()
       where id = v_series.id;
      continue;
    end if;

    -- This period already has its copy (or a later one exists).
    if v_latest.series_period_start is not null and v_latest.series_period_start >= v_period then
      continue;
    end if;

    v_new := null;

    insert into vizserve_pms_tasks (
      request_id, department_id, list_id, is_personal, title, description, status,
      assignee_id, qa_assignee_id, start_date, due_date, priority, estimate_minutes,
      custom_fields, created_by, series_id, series_period_start
    ) values (
      null,
      v_latest.department_id,
      v_latest.list_id,
      v_latest.is_personal,
      v_latest.title,
      v_latest.description,
      v_series.landing_status,
      v_latest.assignee_id,
      v_latest.qa_assignee_id,
      vizserve_pms_shift_into_period(v_series.frequency, v_latest.start_date,
        coalesce(v_latest.series_period_start, v_period), v_period),
      vizserve_pms_shift_into_period(v_series.frequency, v_latest.due_date,
        coalesce(v_latest.series_period_start, v_period), v_period),
      v_latest.priority,
      v_latest.estimate_minutes,
      v_latest.custom_fields,
      coalesce(v_series.created_by, v_latest.created_by),
      v_series.id,
      v_period
    )
    on conflict (series_id, series_period_start) where series_id is not null do nothing
    returning id into v_new;

    -- Somebody else's run got there first.
    if v_new is null then
      continue;
    end if;

    insert into vizserve_pms_task_assignees (task_id, user_id)
    select v_new, a.user_id from vizserve_pms_task_assignees a where a.task_id = v_latest.id
    on conflict do nothing;

    -- Unticked: the procedure is about to be followed again (P7-68, P7-69).
    insert into vizserve_pms_task_checklist_items (task_id, group_label, label, is_done, position)
    select v_new, c.group_label, c.label, false, c.position
      from vizserve_pms_task_checklist_items c
     where c.task_id = v_latest.id;

    perform vizserve_pms_write_audit_log(
      'task', v_new, 'created', null, null,
      jsonb_build_object('recurring', true, 'series_id', v_series.id, 'period_start', v_period,
                         'copied_from', v_latest.id)
    );

    if v_latest.assignee_id is not null then
      perform vizserve_pms_emit(
        'task.assigned',
        jsonb_build_object('assignee', jsonb_build_array(v_latest.assignee_id)),
        'Assigned to you: ' || v_latest.title,
        'The next copy of a recurring task.', 'task', v_new, '/tasks/' || v_new::text
      );
    end if;

    /*
     * ⚠️ THE PREVIOUS COPIES CLOSE, AND ONLY THEIR STATUS CHANGES. Every
     * earlier, still-open copy of this series moves to COMPLETED with a
     * history row that says why and names no person (`actor_id` null, as the
     * Gate 3 auto-complete does). Its timesheet entries are untouched, so the
     * week it belongs to reads exactly as it did.
     */
    v_closed := 0;
    for v_row in
      select t.id, t.status
        from vizserve_pms_tasks t
       where t.series_id = v_series.id
         and t.id <> v_new
         and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
       for update
    loop
      update vizserve_pms_tasks set status = 'COMPLETED' where id = v_row.id;

      insert into vizserve_pms_task_status_history (task_id, from_status, to_status, actor_id, comment)
      values (v_row.id, v_row.status, 'COMPLETED', null,
              'Closed automatically: the next copy of this recurring task has started.');

      perform vizserve_pms_write_audit_log(
        'task', v_row.id, 'auto_completed', null,
        jsonb_build_object('status', v_row.status),
        jsonb_build_object('status', 'COMPLETED', 'reason', 'recurring task rolled over')
      );

      v_closed := v_closed + 1;
    end loop;

    series_id := v_series.id;
    task_id := v_new;
    closed_count := v_closed;
    return next;
  end loop;
end;
$$;

revoke all on function vizserve_pms_generate_recurring_tasks(date) from public, anon, authenticated;
grant execute on function vizserve_pms_generate_recurring_tasks(date) to service_role;

-- ---------------------------------------------------------------------------
-- `repeats` — a PostgREST computed column (the P9-05 `is_mine` pattern), so
-- every task read can ask for it in its select list and get the frequency of
-- an ACTIVE schedule, or null. Unprefixed for the same reason `is_mine` is: to
-- a caller it is a column.
--
-- SECURITY DEFINER because the series table's own policy would cost a task
-- scan per row; it only ever runs on a task row the caller has already been
-- given, and returns nothing but the frequency.
-- ---------------------------------------------------------------------------

create or replace function repeats(t vizserve_pms_tasks)
returns vizserve_pms_recurrence_frequency
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.frequency from vizserve_pms_task_series s where s.id = t.series_id and s.is_active;
$$;

comment on function repeats(vizserve_pms_tasks) is
  'P15-10. PostgREST computed column: the active schedule''s frequency, or null.';

grant execute on function repeats(vizserve_pms_tasks) to authenticated;

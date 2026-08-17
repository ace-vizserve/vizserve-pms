-- P6-01 — the timesheet.
--
-- Amier, 33:20–34:40: time is logged AGAINST A TASK CHOSEN FROM A LIST. Free
-- text is forbidden. "mamap niya yung item mo sa list... hindi ka rin
-- pwede-pwede mag-log ng gusto mo."
--
-- `task_id NOT NULL` is that rule, and docs/09 is explicit that this single
-- constraint IS the feature. Everything else in this file exists to stop the
-- constraint being satisfied dishonestly — a nullable-by-another-name task, a
-- task belonging to somebody else, a day that has not happened yet.
--
-- Durations, not intervals. An entry is "90 minutes on this task on this day",
-- not a start and an end: the DTR already owns when somebody was at work, and
-- two tables both claiming to know that is two tables that will disagree. This
-- one answers a different question — where the day went (53:30, "makita talaga
-- yung totoong output ng member").

-- ---------------------------------------------------------------------------
-- Several entries per task per day are allowed on purpose — no unique key on
-- (user, task, date). An hour before lunch and two after is two facts with two
-- notes, and collapsing them into one row loses the notes, which are the part a
-- reviewer actually reads.
-- ---------------------------------------------------------------------------
create table vizserve_pms_timesheet_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references vizserve_pms_users (id) on delete cascade,

  -- THE feature. Not null, and no default — there is deliberately no way to
  -- write a row that is not attached to real work.
  task_id    uuid not null references vizserve_pms_tasks (id) on delete cascade,

  work_date  date not null,

  -- Minutes rather than a numeric of hours: 7.4 hours is ambiguous between 7h24
  -- and 7h40 depending on who is reading, and rounding it repeatedly through a
  -- week's totals is how a timesheet stops adding up. The UI presents hours and
  -- minutes; the storage is exact.
  minutes    integer not null,
  note       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A day is 1440 minutes. The per-day total is checked by trigger below; this
  -- is the cheap per-row bound that catches a fat-fingered 800 hours before it
  -- reaches the trigger.
  constraint vizserve_pms_timesheet_entries_minutes_range
    check (minutes > 0 and minutes <= 1440),

  -- An empty note is not a note. Stored as NULL so "has a note" is one test
  -- rather than two, everywhere it is read.
  constraint vizserve_pms_timesheet_entries_note_not_blank
    check (note is null or length(btrim(note)) > 0)
);

create index vizserve_pms_timesheet_entries_user_date_idx
  on vizserve_pms_timesheet_entries (user_id, work_date desc);

-- P6-05's "actual hours vs turnaround" reads by task, not by person.
create index vizserve_pms_timesheet_entries_task_idx
  on vizserve_pms_timesheet_entries (task_id);

create trigger vizserve_pms_timesheet_entries_updated_at
  before update on vizserve_pms_timesheet_entries
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- Is this task one the person may log against?
--
-- A helper rather than an inline EXISTS because the same test is needed by the
-- INSERT policy, the UPDATE policy and the task picker. Three copies of a rule
-- is three chances for one of them to drift looser than the others.
--
-- PIC or QA reviewer. Not "anyone in the department": a lead who did not do the
-- work should not be able to book hours to it, and if they genuinely did the
-- work, the fix is to assign it to them — which is a fact worth recording
-- anyway.
--
-- STABLE, not IMMUTABLE: it reads tables. Marking it immutable would let the
-- planner cache a result across the statement that changes it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_may_log_time(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_tasks t
     where t.id = p_task_id
       and (t.assignee_id = p_user_id or t.qa_assignee_id = p_user_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- The per-day cap.
--
-- A trigger rather than a CHECK because the rule spans rows: a CHECK can only
-- see the row in front of it, and the way this goes wrong is six plausible
-- entries totalling thirty hours.
--
-- Locks the day's existing rows before summing. Without FOR UPDATE two
-- concurrent inserts each read a total that does not include the other and both
-- pass — the classic write-skew, and a timesheet is exactly the kind of thing
-- somebody submits from two tabs.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_check_timesheet_day_total()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_total integer;
begin
  -- Two statements, not one. `SELECT sum(...) FOR UPDATE` is rejected outright
  -- — FOR UPDATE is not allowed with aggregates — so the rows are locked first
  -- and totalled second.
  perform 1
    from vizserve_pms_timesheet_entries e
   where e.user_id = new.user_id
     and e.work_date = new.work_date
     and e.id <> new.id
   for update;

  select coalesce(sum(e.minutes), 0) into v_total
    from vizserve_pms_timesheet_entries e
   where e.user_id = new.user_id
     and e.work_date = new.work_date
     and e.id <> new.id;

  if v_total + new.minutes > 1440 then
    raise exception 'That would put % over 24 hours for one day.', new.work_date
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vizserve_pms_timesheet_entries_day_total
  before insert or update on vizserve_pms_timesheet_entries
  for each row execute function vizserve_pms_check_timesheet_day_total();

alter table vizserve_pms_timesheet_entries enable row level security;
revoke all on vizserve_pms_timesheet_entries from anon;

-- Your own rows always; your team's if you lead their department — the same
-- shape as the DTR, and for the same reason: the entry carries no department of
-- its own, so scope resolves through the person it belongs to.
-- vizserve_pms_manages_department already returns true for an admin.
create policy "timesheet readable by owner and department leads"
  on vizserve_pms_timesheet_entries for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
        from vizserve_pms_users u
       where u.id = vizserve_pms_timesheet_entries.user_id
         and vizserve_pms_manages_department(u.primary_department_id)
    )
  );

-- Writes are first-person only. A lead reads their team's timesheet and cannot
-- write to it: hours somebody else entered under your name are not your hours,
-- and the correction path for a wrong entry is the person who owns it fixing it.
--
-- `now() at time zone 'Asia/Manila'` rather than current_date, which is UTC on
-- Supabase — between 16:00 and midnight Manila those are different days, and
-- the difference would show up as "you cannot log today" every single evening.
create policy "timesheet insertable by owner"
  on vizserve_pms_timesheet_entries for insert to authenticated
  with check (
    user_id = auth.uid()
    and vizserve_pms_may_log_time(task_id, auth.uid())
    and work_date <= (now() at time zone 'Asia/Manila')::date
  );

create policy "timesheet updatable by owner"
  on vizserve_pms_timesheet_entries for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and vizserve_pms_may_log_time(task_id, auth.uid())
    and work_date <= (now() at time zone 'Asia/Manila')::date
  );

create policy "timesheet deletable by owner"
  on vizserve_pms_timesheet_entries for delete to authenticated
  using (user_id = auth.uid());

-- The grants incident (docs/13): Supabase's default privileges do not reach
-- tables created by these migrations. A missing GRANT reads as `permission
-- denied for table`; a failing POLICY returns zero rows. They are never the
-- same diagnosis.
grant select, insert, update, delete on vizserve_pms_timesheet_entries to authenticated;
grant execute on function vizserve_pms_may_log_time(uuid, uuid) to authenticated;

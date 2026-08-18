-- P7-05 — a week of timesheet becomes a thing you submit and a lead approves.
--
-- The third consumer of the P2-00 approval engine, after Gate 1 and the internal
-- request types. Nothing in the engine changes — `entity_type` is a plain text
-- discriminator with no foreign key precisely so that this file can exist.
--
-- Note what this consumer asks of the engine compared with the last one:
--
--   internal requests   approved | rejected     (never returned)
--   timesheet weeks     approved | returned     (never rejected)
--
-- Opposite subsets of the same decision enum. There is no meaningful terminal
-- rejection of hours somebody already worked — you either accept them or send
-- them back to be fixed. Two consumers wanting opposite halves and neither
-- needing an engine change is the acceptance test docs/06 set for the
-- abstraction, met a second time.
--
-- THE LOCK IS THE FEATURE. An approval that does not stop the thing being
-- edited afterwards is decoration. Most of this file exists to make submitted
-- weeks read-only without giving anybody a way to edit somebody else's hours.

-- ---------------------------------------------------------------------------
-- No DRAFT.
--
-- The absence of a row IS the draft state. A status value that never appears in
-- the table is a value somebody eventually writes by mistake, and then half the
-- queries have to remember to exclude it.
--
-- `CREATE TYPE` may be used in the transaction that creates it — the "enum in
-- its own file" rule (20260804151000, 20260818100000) applies only to
-- `ALTER TYPE ... ADD VALUE`.
-- ---------------------------------------------------------------------------
create type vizserve_pms_timesheet_week_status as enum (
  'SUBMITTED',
  'RETURNED',
  'APPROVED'
);

create table vizserve_pms_timesheet_weeks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references vizserve_pms_users (id) on delete cascade,

  -- Always a Monday. The submit function truncates whatever it is given, and
  -- this constraint is what makes the unique key below mean what it says
  -- rather than merely usually meaning it. `extract` on a date is immutable, so
  -- unlike "not in the future" this one CAN live in a CHECK.
  week_start date not null,

  -- Snapshotted at submission, not resolved live through the user's current
  -- department. This differs on purpose from the entries table, whose SELECT
  -- policy walks through vizserve_pms_users every time: an entry is a live fact
  -- with no decision attached, but a submitted week is a decision-bearing
  -- artefact and has to keep the department it was decided under. Same argument
  -- as vizserve_pms_approvals.department_id.
  department_id uuid not null references vizserve_pms_departments (id) on delete restrict,

  status vizserve_pms_timesheet_week_status not null default 'SUBMITTED',

  -- What the person attested to when they pressed submit. The reviewer reads
  -- LIVE entries, so if a returned week comes back different this is what the
  -- difference is measured against.
  submitted_minutes integer not null,
  submitted_at      timestamptz not null default now(),

  decision_reason text,
  reviewed_by     uuid references vizserve_pms_users (id) on delete set null,
  reviewed_at     timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vizserve_pms_timesheet_weeks_one_per_week unique (user_id, week_start),

  constraint vizserve_pms_timesheet_weeks_monday
    check (extract(isodow from week_start) = 1),

  -- Sending a week back without saying what is wrong makes it unactionable.
  -- The engine enforces the same rule on the approval row; this keeps the copy
  -- on the week itself honest too.
  constraint vizserve_pms_timesheet_weeks_returned_reason
    check (
      status <> 'RETURNED'
      or (decision_reason is not null and length(btrim(decision_reason)) > 0)
    )
);

-- The lead's queue reads by department and status; the member's history by
-- person and week.
create index vizserve_pms_timesheet_weeks_queue_idx
  on vizserve_pms_timesheet_weeks (department_id, status, week_start desc);
create index vizserve_pms_timesheet_weeks_user_idx
  on vizserve_pms_timesheet_weeks (user_id, week_start desc);

create trigger vizserve_pms_timesheet_weeks_updated_at
  before update on vizserve_pms_timesheet_weeks
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- Is this day inside a week that has been handed in?
--
-- `security definer` for exactly the reason vizserve_pms_may_log_time is: this
-- runs INSIDE the entries table's policies, and a non-definer function would
-- evaluate the weeks table's own RLS in there — a policy consulting a policy,
-- which is both slow and hard to reason about.
--
-- RETURNED is absent from the status list, and that one omission is the entire
-- "sending a week back unlocks it" mechanism. No second flag, no third state.
--
-- `date_trunc('week', ...)` on a DATE is ISO — Monday-based — and immutable.
-- It must never be handed `now()` directly; see the submit function below.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_timesheet_week_locked(
  p_user_id   uuid,
  p_work_date date
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_timesheet_weeks w
     where w.user_id = p_user_id
       and w.week_start = date_trunc('week', p_work_date)::date
       and w.status in ('SUBMITTED', 'APPROVED')
  );
$$;

alter table vizserve_pms_timesheet_weeks enable row level security;
revoke all on vizserve_pms_timesheet_weeks from anon;

-- Your own weeks; your team's if you lead their department. The department is
-- on the row itself here, unlike the entries table where scope has to resolve
-- through the person — which is the practical benefit of snapshotting it.
create policy "timesheet weeks readable by owner and department leads"
  on vizserve_pms_timesheet_weeks for select to authenticated
  using (
    user_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
  );

-- No INSERT, UPDATE or DELETE policy. Rows arrive only through
-- vizserve_pms_submit_timesheet_week and change only through
-- vizserve_pms_decide_timesheet_week, so a status cannot be set directly and an
-- approval cannot be forged without the matching vizserve_pms_approvals row.

-- ---------------------------------------------------------------------------
-- The entries table's write policies, replaced.
--
-- Postgres has no "alter policy, add a clause" — a policy is dropped and
-- recreated. The names match 20260817090000 exactly so the pair reads as one
-- rule with a later amendment rather than two competing ones.
-- ---------------------------------------------------------------------------
drop policy "timesheet insertable by owner" on vizserve_pms_timesheet_entries;
drop policy "timesheet updatable by owner" on vizserve_pms_timesheet_entries;
drop policy "timesheet deletable by owner" on vizserve_pms_timesheet_entries;

create policy "timesheet insertable by owner"
  on vizserve_pms_timesheet_entries for insert to authenticated
  with check (
    user_id = auth.uid()
    and vizserve_pms_may_log_time(task_id, auth.uid())
    and work_date <= (now() at time zone 'Asia/Manila')::date
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  );

-- The lock test appears in BOTH halves, and the USING half is the load-bearing
-- one. WITH CHECK evaluates the NEW row: with the test only there,
--
--   update ... set work_date = <some unlocked day> where id = <row in a
--   submitted week>
--
-- passes, because the new row's date is not locked. That silently removes hours
-- from a week somebody has already approved. USING evaluates the row as it
-- stands, which is what refuses to let it be moved out in the first place.
create policy "timesheet updatable by owner"
  on vizserve_pms_timesheet_entries for update to authenticated
  using (
    user_id = auth.uid()
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  )
  with check (
    user_id = auth.uid()
    and vizserve_pms_may_log_time(task_id, auth.uid())
    and work_date <= (now() at time zone 'Asia/Manila')::date
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  );

create policy "timesheet deletable by owner"
  on vizserve_pms_timesheet_entries for delete to authenticated
  using (
    user_id = auth.uid()
    and not vizserve_pms_timesheet_week_locked(auth.uid(), work_date)
  );

-- The SELECT policy is untouched. A locked week stays readable by its owner and
-- by their lead — being readable while unwritable is the entire point of
-- handing it in.

-- ---------------------------------------------------------------------------
-- Submitting.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_submit_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_name       text;
  v_week       date;
  v_this_week  date;
  v_total      integer;
  v_existing   vizserve_pms_timesheet_weeks;
  v_id         uuid;
  v_approver   record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- Normalised, never trusted. Any day in the week works as an anchor, which
  -- matches what the page already does with `startOfWeek` before it puts the
  -- week in the URL.
  v_week := date_trunc('week', p_week_start)::date;

  -- Manila FIRST, then truncate. `date_trunc('week', now())` operates on a
  -- timestamptz in the session zone — UTC on Supabase — which moves the week
  -- boundary for eight hours every Sunday evening. Getting these two operations
  -- the wrong way round is a bug that only appears on Sunday nights.
  v_this_week := date_trunc('week', (now() at time zone 'Asia/Manila')::date)::date;

  if v_week > v_this_week then
    raise exception 'That week has not happened yet.' using errcode = 'check_violation';
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

  -- Lock the week's rows before totalling them, the same idiom the day-total
  -- trigger uses. Without it somebody editing in another tab can change the
  -- total between the sum and the insert, and `submitted_minutes` would record
  -- a figure that was never true.
  perform 1
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6
   for update;

  select coalesce(sum(e.minutes), 0) into v_total
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6;

  -- An approved empty week is a signed statement that somebody did nothing for
  -- five days. It is almost always a misclick on the wrong week.
  if v_total = 0 then
    raise exception 'There is nothing logged in that week to submit.'
      using errcode = 'check_violation';
  end if;

  select * into v_existing
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  -- Explicit branches rather than `on conflict`, so each refusal gets its own
  -- sentence. "Already submitted" and "already approved" need different advice.
  if v_existing.id is not null then
    if v_existing.status = 'SUBMITTED' then
      raise exception 'That week is already with your lead.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_existing.status = 'APPROVED' then
      raise exception 'That week has been approved. Ask your lead to send it back if it needs changing.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- RETURNED: fixed and going back. The previous decision is cleared rather
    -- than kept, because a week showing both "sent back for X" and "submitted"
    -- reads as though X is still outstanding.
    update vizserve_pms_timesheet_weeks
       set status            = 'SUBMITTED',
           submitted_minutes = v_total,
           submitted_at      = now(),
           decision_reason   = null,
           reviewed_by       = null,
           reviewed_at       = null
     where id = v_existing.id;

    v_id := v_existing.id;
  else
    insert into vizserve_pms_timesheet_weeks (
      user_id, week_start, department_id, status, submitted_minutes
    ) values (
      v_user, v_week, v_department, 'SUBMITTED', v_total
    )
    returning id into v_id;
  end if;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_id, 'submitted', v_user, null,
    jsonb_build_object('week_start', v_week, 'minutes', v_total)
  );

  -- Everyone who leads the department, for the same reason the internal
  -- requests do it: a queue with one named owner stalls the week that person is
  -- away, and a timesheet queue stalling means payroll stalling.
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
      'Timesheet from ' || v_name,
      'Week of ' || to_char(v_week, 'DD Mon YYYY'),
      'timesheet_week',
      v_id,
      '/timesheet/team?week=' || v_week::text
    );
  end loop;

  return jsonb_build_object('ok', true, 'id', v_id, 'minutes', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- Deciding.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_decide_timesheet_week(
  p_id       uuid,
  p_decision vizserve_pms_approval_decision,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_week   vizserve_pms_timesheet_weeks;
  v_status vizserve_pms_timesheet_week_status;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- The mirror image of the internal-request consumer, which refuses
  -- 'returned'. Hours that were worked cannot be un-worked, so there is nothing
  -- for a rejection to mean.
  if p_decision = 'rejected' then
    raise exception 'A week of work is approved or sent back to be fixed, not rejected.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_week
    from vizserve_pms_timesheet_weeks
   where id = p_id
   for update;

  if v_week.id is null then
    raise exception 'That timesheet no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_week.status <> 'SUBMITTED' then
    raise exception 'That timesheet has already been decided.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The engine checks departmental scope, and a team leader IS in the
  -- department they lead — so scope alone would let them approve their own
  -- week. Same guard, same reason, as the internal requests.
  if v_week.user_id = auth.uid() then
    raise exception 'You cannot approve your own timesheet.'
      using errcode = 'insufficient_privilege';
  end if;

  -- THE ENGINE CALL. Scope, the mandatory reason on anything that is not an
  -- approval, the vizserve_pms_approvals row and its audit entry are all handled
  -- in there. Untouched since Phase 2.
  perform vizserve_pms_record_decision(
    'timesheet_week', p_id, v_week.department_id, p_decision, p_reason
  );

  v_status := case when p_decision = 'approved' then 'APPROVED' else 'RETURNED' end;

  update vizserve_pms_timesheet_weeks
     set status          = v_status,
         decision_reason = v_reason,
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', p_id, lower(v_status::text), auth.uid(),
    to_jsonb(v_week), jsonb_build_object('status', v_status, 'reason', v_reason)
  );

  -- Inbox only, no email — the same channel policy as a decision on your own
  -- leave request, and the reason `internal_decision` is reused rather than a
  -- new notification type being minted for a difference nobody reads.
  perform vizserve_pms_notify(
    v_week.user_id,
    'internal_decision',
    case when p_decision = 'approved'
         then 'Timesheet approved'
         else 'Timesheet sent back' end,
    coalesce(v_reason, 'Week of ' || to_char(v_week.week_start, 'DD Mon YYYY')),
    'timesheet_week',
    p_id,
    '/timesheet?week=' || v_week.week_start::text
  );

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

-- The grants incident (docs/13): Supabase's default privileges do not reach
-- tables created by these migrations. A missing GRANT reads as `permission
-- denied for table ...`; a failing POLICY returns zero rows. Never the same
-- diagnosis, never the same fix.
grant select on vizserve_pms_timesheet_weeks to authenticated;

-- ⚠️ This one is not optional and not obvious. `vizserve_pms_timesheet_week_locked`
-- is invoked INSIDE the entries table's policies, and policy expressions run as
-- the querying role. Without this grant every timesheet insert fails with
-- `permission denied for function` — which reads like a grants problem on the
-- entries table and is not.
grant execute on function vizserve_pms_timesheet_week_locked(uuid, date) to authenticated;
grant execute on function vizserve_pms_submit_timesheet_week(date) to authenticated;
grant execute on function vizserve_pms_decide_timesheet_week(
  uuid, vizserve_pms_approval_decision, text
) to authenticated;

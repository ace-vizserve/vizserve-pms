-- P5-01 / P5-02 — DTR: the daily time record.
--
-- Amier's rules, verbatim (19:10–21:00): default view is a list of time in /
-- time out by date; the EARLIEST time-in wins and can never be overwritten; the
-- LATEST time-out wins; and a time-out may be attached to the previous day so
-- that an OT shift ending 01:00 lands on the date the work started.
--
-- Those rules as stated have two holes, recorded as R3 and raised as Q4:
--
--   1. No correction path. "Earliest in wins, forever" means an accidental
--      06:00 punch can never be fixed by the person it happened to.
--   2. Backdating. An unconstrained date picker lets someone attach a punch to
--      a more favourable past date.
--
-- This migration implements the Q4 recommendation, which closes both without
-- losing the intent:
--
--   * The SERVER timestamp is always the punch. The date picker only chooses
--     which work_date the punch attaches to — it never sets the time.
--   * Time-IN takes no date at all. It is always today. That removes the
--     backdating hole outright rather than validating it away.
--   * Time-OUT may attach to today, or to yesterday ONLY when yesterday's shift
--     was left open. That is the narrowest window that still serves the worked
--     example (in 22:00 Jul 22, out 01:00 Jul 23 → recorded against Jul 22).
--   * Corrections go through No Time-In / No Time-Out approval requests, which
--     is precisely why those two form types exist (P5-09).
--
-- ⚠️ Q4 IS STILL OPEN. Amier has not confirmed these constraints, and Q8 —
-- whether anyone works a scheduled shift that starts and ends on different
-- calendar days — has not been answered either. What is built here handles OT
-- that runs late, which is the rule as stated. A scheduled 22:00–06:00 shift is
-- a different model and would need this revisited.

-- ---------------------------------------------------------------------------
-- One row per person per work date. The UNIQUE is the feature, not a detail:
-- it is what makes "earliest in wins" expressible as a single upsert instead of
-- a read-then-write that two simultaneous punches can interleave through.
-- ---------------------------------------------------------------------------
create table vizserve_pms_dtr_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references vizserve_pms_users (id) on delete cascade,
  work_date    date not null,

  time_in      timestamptz,
  time_out     timestamptz,

  -- Provenance for P5-09. A time that arrived through an approved correction is
  -- a different fact from a time somebody punched, and payroll disputes are
  -- exactly where that difference gets argued about.
  corrected_by          uuid references vizserve_pms_users (id) on delete set null,
  corrected_at          timestamptz,
  -- FK deliberately absent here: vizserve_pms_internal_requests does not exist
  -- until the next migration, which adds the constraint. Kept as a bare uuid so
  -- the two files stay independently applicable in filename order.
  correction_request_id uuid,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint vizserve_pms_dtr_entries_user_date_unique unique (user_id, work_date),

  -- An out before an in is not a short shift, it is corrupt data. Compared as
  -- instants, so the overnight case (22:00 → 01:00) passes and only genuine
  -- inversions fail.
  constraint vizserve_pms_dtr_entries_out_after_in
    check (time_out is null or time_in is null or time_out >= time_in)
);

create index vizserve_pms_dtr_entries_user_date_idx
  on vizserve_pms_dtr_entries (user_id, work_date desc);
create index vizserve_pms_dtr_entries_date_idx
  on vizserve_pms_dtr_entries (work_date desc);

create trigger vizserve_pms_dtr_entries_updated_at
  before update on vizserve_pms_dtr_entries
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- P5-02 — THE PUNCH ENDPOINT.
--
-- SECURITY DEFINER with no INSERT or UPDATE policy behind it, the same shape as
-- the approval engine. Times are the one thing in this table nobody may write
-- directly: if a client could UPDATE, "earliest in wins" would be a suggestion.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_punch(
  p_direction text,
  -- Time-out only, and only today or yesterday. Null means today.
  p_work_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user      uuid := auth.uid();
  v_now       timestamptz := now();
  v_today     date := (v_now at time zone 'Asia/Manila')::date;
  v_work_date date;
  v_entry     vizserve_pms_dtr_entries;
  v_existing  vizserve_pms_dtr_entries;
  v_captured  boolean := true;
  v_message   text;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from vizserve_pms_users u where u.id = v_user and u.is_active) then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if p_direction not in ('in', 'out') then
    raise exception 'Punch direction must be in or out.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- -------------------------------------------------------------------- IN
  if p_direction = 'in' then
    -- Loud rather than ignored. A caller passing a date here has misunderstood
    -- the rule, and silently discarding it would hide that until payroll.
    if p_work_date is not null and p_work_date <> v_today then
      raise exception 'Time-in always records against today.'
        using errcode = 'invalid_parameter_value';
    end if;

    v_work_date := v_today;

    select * into v_existing
      from vizserve_pms_dtr_entries
     where user_id = v_user and work_date = v_work_date;

    -- EARLIEST WINS. coalesce keeps whatever is already there, so a second,
    -- third and tenth punch are all no-ops on the value. Expressed as an upsert
    -- so two taps landing together cannot both read "empty" and both write.
    insert into vizserve_pms_dtr_entries (user_id, work_date, time_in)
    values (v_user, v_work_date, v_now)
    on conflict (user_id, work_date) do update
       set time_in = coalesce(vizserve_pms_dtr_entries.time_in, excluded.time_in)
    returning * into v_entry;

    v_captured := v_existing.time_in is null;
    v_message := case
      when v_captured then 'Timed in.'
      else 'You already timed in today. The earliest time-in stands.'
    end;

  -- ------------------------------------------------------------------- OUT
  else
    v_work_date := coalesce(p_work_date, v_today);

    if v_work_date > v_today then
      raise exception 'You cannot time out for a future date.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_work_date < v_today - 1 then
      raise exception 'A time-out can only be recorded for today or yesterday. Raise a No Time-Out request for anything older.'
        using errcode = 'invalid_parameter_value';
    end if;

    select * into v_existing
      from vizserve_pms_dtr_entries
     where user_id = v_user and work_date = v_work_date
     for update;

    if v_existing.id is null or v_existing.time_in is null then
      raise exception 'There is no time-in on % to close.', v_work_date
        using errcode = 'invalid_parameter_value';
    end if;

    -- Yesterday is reachable only to close a shift that is genuinely still
    -- open. Without this the "previous day" allowance becomes a general edit
    -- of yesterday's finished record.
    if v_work_date < v_today and v_existing.time_out is not null then
      raise exception 'Yesterday is already closed. Raise a No Time-Out request to change it.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- A shift nobody closed for 18 hours is a forgotten punch, not a long day.
    -- Accepting it writes a fabricated shift into payroll, and because time-in
    -- can never be overwritten there is no way back from it.
    if v_now > v_existing.time_in + make_interval(hours => 18) then
      raise exception 'That shift has been open more than 18 hours. Raise a No Time-Out request so it can be corrected.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- LATEST WINS. greatest() rather than a bare assignment so that a clock
    -- skew, or a correction that already wrote a later time, cannot be walked
    -- backwards by a stray tap.
    update vizserve_pms_dtr_entries
       set time_out = greatest(coalesce(time_out, v_now), v_now)
     where id = v_existing.id
    returning * into v_entry;

    v_message := case
      when v_existing.time_out is null then 'Timed out.'
      else 'Time-out updated. The latest time-out stands.'
    end;
  end if;

  -- Every punch is logged, including the ones that changed nothing.
  --
  -- This is the point of auditing here at all: the disputed punch is always the
  -- one that was IGNORED. "I clocked in at eight, why does it say six" is
  -- unanswerable from a table that only keeps the winner.
  perform vizserve_pms_write_audit_log(
    'dtr_entry',
    v_entry.id,
    'punch_' || p_direction,
    v_user,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    jsonb_build_object(
      'work_date', v_work_date,
      'punched_at', v_now,
      'captured', v_captured,
      'time_in', v_entry.time_in,
      'time_out', v_entry.time_out
    )
  );

  return jsonb_build_object(
    'ok', true,
    'captured', v_captured,
    'message', v_message,
    'work_date', v_work_date,
    'time_in', v_entry.time_in,
    'time_out', v_entry.time_out
  );
end;
$$;

alter table vizserve_pms_dtr_entries enable row level security;
revoke all on vizserve_pms_dtr_entries from anon;

-- Your own record always; your team's if you lead their department. The DTR row
-- carries no department of its own, so scope is resolved through the person it
-- belongs to — their CURRENT department, which is the one whose leader is
-- accountable for them now.
--
-- vizserve_pms_manages_department already returns true for an admin, so there is
-- no separate admin branch here.
create policy "dtr readable by owner and department leads"
  on vizserve_pms_dtr_entries for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
        from vizserve_pms_users u
       where u.id = vizserve_pms_dtr_entries.user_id
         and vizserve_pms_manages_department(u.primary_department_id)
    )
  );

-- No INSERT and no UPDATE policy, deliberately. Rows arrive through
-- vizserve_pms_punch and are amended through the approved-correction path in
-- P5-09 — both SECURITY DEFINER. A team leader cannot hand-edit a subordinate's
-- hours, which is the property that makes the record worth anything.

-- The grants incident (docs/13): Supabase's default privileges do not reach
-- tables created by these migrations, so SELECT is granted explicitly. Without
-- it this reads `permission denied for table`, which is a GRANT problem and
-- never an RLS one.
grant select on vizserve_pms_dtr_entries to authenticated;
grant execute on function vizserve_pms_punch(text, date) to authenticated;

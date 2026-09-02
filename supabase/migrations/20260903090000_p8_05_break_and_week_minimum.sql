-- ---------------------------------------------------------------------------
-- P8-05 — a week short of its schedule is refused, and the break that makes
-- "its schedule" a number at all.
--
-- P7-36 left an explicit warning on `vizserve_pms_users.work_end` and this file
-- is the thing it warned about:
--
--   "NOTE this span includes the unpaid break: 08:00-17:00 describes an
--    eight-hour day. Nothing computes scheduled DURATION from these two columns
--    today, and anything that starts to — 'hours short of schedule', say —
--    needs a break column first, because (work_end - work_start) is not the
--    number it is looking for."
--
-- So the break comes first, in two places, and the check comes after it.
--
-- ⚠️ WHY THE BREAK IS TWO COLUMNS AND NOT ONE. The company setting is the
-- answer for almost everybody and belongs where an admin can change it without
-- a deploy (P7-37's whole argument). The per-person column exists because the
-- one case that matters is the exception: somebody on a half-hour break, or on
-- none at all, judged against a company hour would be told they are short every
-- single week, forever, and there would be no way to say otherwise. That is the
-- failure mode this column prevents, and it is why NULL and 0 must stay
-- distinguishable — see the column comment.
--
-- WHAT THIS DELIBERATELY IS NOT: a claim about pay, entitlement or overtime.
-- Nothing here writes a figure anywhere. It refuses one submission with a
-- sentence, and every path out of that refusal — log the missing time, file the
-- leave, or ask an admin to fix a schedule that is wrong — is a thing a person
-- can do without anybody's help.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`. This one goes AFTER P7-36 (the work
-- hours), P7-37 (the settings row) and P7-33 (`vizserve_pms_is_working_day`),
-- all three of which it reads. P7-33's `vizserve_pms_leave_days` is NOT used
-- here — see the loop below for why counting leave per request was wrong.
--
-- No `ALTER TYPE ... ADD VALUE` anywhere below, so the whole file is one
-- transaction and the enum-in-its-own-file rule does not apply.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- (a) The company break. A second typed column on the singleton, exactly as
-- P7-37's header said the next setting would be.
--
-- `not null default 60` backfills the seeded row on the way past, so there is
-- no second INSERT here and no window in which the setting is unknown. Sixty
-- minutes is the arrangement this company actually works to; it is a default,
-- not a rule, and the per-person column below is how anybody departs from it.
--
-- The 0-480 range is a typo guard rather than a policy claim, in the same voice
-- as `grace_minutes`. Zero is legal and means "no unpaid break", which is a real
-- arrangement. Eight hours is the ceiling because a break longer than the
-- working day it sits inside is a mistyped figure, and the consequence of
-- obeying it is that every schedule in the company computes to zero and the
-- check below silently switches itself off for everyone.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_app_settings
  add column break_minutes integer not null default 60;

alter table vizserve_pms_app_settings
  add constraint vizserve_pms_app_settings_break_range
    check (break_minutes >= 0 and break_minutes <= 480);

comment on column vizserve_pms_app_settings.break_minutes is
  'P8-05. The unpaid break inside the scheduled day, company-wide. Subtracted '
  'from (work_end - work_start) to get the hours a day is actually worth — see '
  'the note on vizserve_pms_users.work_end. Overridden per person by '
  'vizserve_pms_users.break_minutes when that is not null.';


-- ---------------------------------------------------------------------------
-- (b) The per-person override.
--
-- ⚠️ NULLABLE, NO DEFAULT, AND THAT IS THE WHOLE DESIGN OF THIS COLUMN.
--
-- `default 60` is the obvious thing to write and it is wrong twice over. It
-- would claim, on the day this migration runs, that every person already on the
-- staff list has been individually assessed as taking a one-hour break — a fact
-- nobody has established about anybody. And it would permanently collapse the
-- difference between "nobody has set this" and "this person deliberately takes
-- no break", because both would then be a number in the column and the second
-- one is 0.
--
-- NULL means inherit. It is the same posture P7-36 took with work_start /
-- work_end and the same one P7-33 took with an absent allocation row: an unset
-- value is a supported state that reads as a question nobody has answered, not
-- as an answer this schema invented.
--
-- The range is restated rather than shared. A CHECK cannot reference another
-- table, so the two constraints are two copies of one rule by necessity; they
-- are written identically so a search for either finds both.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_users
  add column break_minutes integer;

alter table vizserve_pms_users
  add constraint vizserve_pms_users_break_range
    check (break_minutes is null or (break_minutes >= 0 and break_minutes <= 480));

comment on column vizserve_pms_users.break_minutes is
  'P8-05. This person''s unpaid break, in minutes. NULL means INHERIT the '
  'company figure in vizserve_pms_app_settings.break_minutes — it is not zero, '
  'and 0 is a different, deliberate answer meaning no break at all. Never '
  'default this column: doing so would assert a break for everybody who has '
  'never been asked.';

-- No RLS work and no grant, for the reason P7-36 gives verbatim:
-- vizserve_pms_users already carries read-own, read-managed-departments and
-- write-admin policies, and a table-level `grant select` reaches a column added
-- later. vizserve_pms_handle_new_auth_user inserts (id, email, full_name) and
-- supplies neither of the new columns; both are nullable or defaulted, so SSO
-- is unaffected.


-- ---------------------------------------------------------------------------
-- Minutes, as a person says them. "7h 30m", "8h", "45m".
--
-- Three figures go into the refusal below and all three have to read like
-- something somebody would say out loud, because the sentence is the entire
-- remedy — it is what tells them what to do next. "450" in an error message is
-- a number the reader has to convert before they can act on it.
--
-- No grant: this is only ever called from inside a SECURITY DEFINER function,
-- where privilege checks are made as the definer. It is not part of any API.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_minutes_text(p_minutes integer)
returns text
language sql
immutable
as $$
  select case
    when p_minutes is null then null
    when p_minutes < 60    then p_minutes || 'm'
    when p_minutes % 60 = 0 then (p_minutes / 60) || 'h'
    else (p_minutes / 60) || 'h ' || (p_minutes % 60) || 'm'
  end;
$$;

comment on function vizserve_pms_minutes_text(integer) is
  'P8-05. Minutes as "7h 30m" / "8h" / "45m", for error messages a person has '
  'to act on. Presentation only — nothing computes from its output.';


-- ---------------------------------------------------------------------------
-- Submitting, with the shortfall check.
--
-- `create or replace`, and the signature is unchanged — so no drop, no lost
-- grants, and nothing else in this file has to re-issue them. Everything
-- outside the new block is P7-05's function as it stands.
--
-- ⚠️ WHERE THE CHECK SITS, AND WHY IT IS NOT EARLIER OR LATER.
--
-- Not EARLIER than the entry lock and total: by the time it runs the week's
-- entry rows are locked `for update` and v_total is the figure this submission
-- will actually record, so the number being judged and the number being stored
-- cannot differ. Judging a total another tab could still change is meaningless.
--
-- Not EARLIER than the existing-week lookup either, which is where it first
-- landed and was wrong. IDENTITY-OF-STATE ERRORS MUST WIN OVER CONTENT ERRORS:
-- a week that is already SUBMITTED or APPROVED is not the caller's to fix, so
-- telling them "that week is 2h short" sends them to log hours the timesheet
-- is locked against. Reachable without doing anything strange — a second tab,
-- or an admin lowering break_minutes under a week that was approved months ago.
--
-- Not LATER than the RETURNED update or the INSERT: a resubmission is a
-- submission and is checked on exactly the same terms. That is why the existing
-- row is inspected in TWO blocks — refusals first, check, then the write.
--
-- ⚠️ THREE EXEMPTIONS, EACH A SHORT-CIRCUIT TO "NO CHECK". Every one of them is
-- a case where refusing would invent a shortfall out of a fact nobody recorded:
--
--   1. No work_start / work_end. Judging somebody against a schedule that was
--      never set is judging them against a guess. Most of this company has no
--      fixed hours (P7-36's whole header), and for them this feature must not
--      exist at all.
--   2. A scheduled day of zero or less. A malformed schedule, or a break longer
--      than the span it sits in, would otherwise make every week short by its
--      whole length — a data-entry mistake in /admin/users would lock somebody
--      out of submitting, and the message would blame their hours.
--   3. No expected days. A week that is entirely holiday or entirely approved
--      leave has nothing owed against it, and `0 * anything` is not a threshold
--      worth applying.
--
-- WHAT IS DELIBERATELY NOT EXEMPT: a week with SOME hours in it but not enough.
-- That is the case this exists for.
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

  -- P8-05. All numeric rather than integer: a scheduled day comes out of an
  -- interval, and a day of leave can be a HALF (P7-16), so the expected count
  -- runs in halves too. Rounding either one early is how a 4.5-day week becomes
  -- a 5-day demand. v_leave holds one day's coverage — 1, 0.5 or 0 — and is
  -- reused each turn of the loop below.
  v_day_minutes numeric;
  v_expected    numeric;
  v_leave       numeric;
  v_minimum     integer;
  v_date        date;
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
  --
  -- ⚠️ BOTH REFUSALS COME BEFORE THE SHORTFALL CHECK, and the header says why:
  -- a week that is not the caller's to change any more must say THAT, not send
  -- them away to log hours into a timesheet the lock already refuses. RETURNED
  -- deliberately falls through — it IS the caller's again, so it is checked.
  if v_existing.id is not null then
    if v_existing.status = 'SUBMITTED' then
      raise exception 'That week is already with your lead.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_existing.status = 'APPROVED' then
      raise exception 'That week has been approved. Ask your lead to send it back if it needs changing.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- P8-05 — the scheduled week, and the refusal if the logged hours fall short.
  --
  -- EXEMPTION 1 lives in the WHERE clause below rather than in an `if`: with no
  -- schedule recorded the select matches no row, v_day_minutes stays NULL, and
  -- the guard that follows reads NULL as "nothing to check". Written this way
  -- so the absence of a schedule and the absence of a settings row degrade
  -- identically — both mean "this app does not know what was expected", and in
  -- both cases the honest response is to accept the week rather than to invent
  -- a figure and refuse it.
  --
  -- `coalesce(u.break_minutes, s.break_minutes)` IS the inheritance rule, in
  -- the one place it is enforced. A NULL on the user falls through to the
  -- company setting; a 0 does not, because 0 is an answer.
  -- -------------------------------------------------------------------------
  select
    (extract(epoch from (u.work_end - u.work_start)) / 60)
      - coalesce(u.break_minutes, s.break_minutes)
    into v_day_minutes
    from vizserve_pms_users u
    -- `on true` because the settings table is a singleton — there is exactly
    -- one row and no key to join it by. LEFT, so a database whose settings row
    -- has somehow gone missing produces a NULL break, then a NULL scheduled day,
    -- and lands on the exemption rather than on a wrong threshold.
    left join vizserve_pms_app_settings s on true
   where u.id = v_user
     and u.work_start is not null
     and u.work_end is not null;

  -- EXEMPTION 2. A non-positive scheduled day is a broken record, not a person
  -- who owes nothing — and a broken record must never be the reason somebody
  -- cannot hand in their week.
  if v_day_minutes is not null and v_day_minutes > 0 then
    -- -----------------------------------------------------------------------
    -- The days somebody would otherwise have been at work, LESS the approved
    -- leave sitting on them. One walk over the week's OWN seven dates.
    --
    -- Walked one at a time through vizserve_pms_is_working_day rather than
    -- counted with a `dow` filter here, so that weekends and the proclaimed
    -- holiday list stay ONE definition — the same argument P7-33 makes for
    -- extracting that function at all. A holiday added by an admin changes this
    -- figure the same day it changes a leave balance.
    --
    -- ⚠️ LEAVE IS COUNTED PER DAY, NOT PER REQUEST, AND THAT IS A FIX.
    --
    -- This block used to `sum(vizserve_pms_leave_days(...))` over the matching
    -- requests. Two approved LEAVE requests both covering the same Wednesday
    -- then subtracted TWO days, while the timesheet screen — which expands
    -- spans into a SET of days through `expandLeaveDays` — subtracted one. On
    -- such a week the screen demanded 1440 minutes and this function only 960:
    -- a false "you are short" on a week Postgres would have accepted, which is
    -- the one direction an advance warning must never be wrong in. A person is
    -- absent ON A DAY, not absent twice, so the de-duplicated count is the
    -- correct one and the SQL moved to meet the TypeScript.
    --
    -- ⚠️ AND THIS IS WHY THE CLIPPING IS GONE. P7-53's greatest/least dance
    -- existed because a request was measured END TO END and a span running out
    -- of the window had to be cut down to it — which then made its start_half /
    -- end_half markers dangerous, because a clipped end is no longer an end of
    -- anything and carrying its half across silently dropped half a day of
    -- leave. Iterating the WEEK'S dates instead of the REQUEST'S means there is
    -- nothing to clip: a date is either in the week or never visited, and the
    -- halves below are read against the request's own real ends every time.
    -- Do not reintroduce greatest/least here; there is no window left to fit.
    -- -----------------------------------------------------------------------
    v_expected := 0;
    v_date := v_week;

    while v_date <= v_week + 6 loop
      if vizserve_pms_is_working_day(v_date) then
        -- -------------------------------------------------------------------
        -- How much of THIS date approved leave covers: 1, 0.5, or 0.
        --
        -- The inner CASE is `portionOfDay` in lib/leave.ts, arm for arm and in
        -- the same order:
        --
        --   start_date + start_half AFTERNOON → away from midday  (a half)
        --   end_date   + end_half   MORNING   → away until midday (a half)
        --   anything else, including every date strictly inside the span → whole
        --
        -- A single-day request is both its own start and its own end, so both
        -- arms are candidates; the start is tested first, exactly as the
        -- TypeScript tests it first. `vizserve_pms_internal_requests_shape`
        -- refuses start_half > end_half on one date, so in practice only one
        -- can fire — the order is there so the two implementations cannot
        -- disagree if that constraint ever loosens.
        --
        -- The coalesce is not decoration: both halves are NULLABLE on rows that
        -- predate P7-16, and null means whole.
        --
        -- The outer CASE is the de-duplication, and it mirrors `merge()`:
        -- one whole day from any request makes the day whole; a MORNING half
        -- and an AFTERNOON half from two DIFFERENT requests also make it whole,
        -- because somebody away all morning and all afternoon is away; two
        -- halves of the same half are still half. Rows but no whole and no
        -- pair → 0.5. No rows at all → the CASE falls out null and coalesce
        -- reads it as 0.
        --
        -- PENDING LEAVE DOES NOT COUNT, matching every other reader of these
        -- rows. A request nobody has decided is not yet a day off, and treating
        -- it as one would let anybody lower their own week's minimum by asking.
        --
        -- Seven small index lookups per submission rather than one aggregate.
        -- The trade is deliberate: a week is seven days, and the shape that
        -- reads correctly is worth more here than the round trip it costs.
        -- -------------------------------------------------------------------
        select coalesce(
                 case
                   when bool_or(part = 'WHOLE') then 1
                   when bool_or(part = 'MORNING') and bool_or(part = 'AFTERNOON') then 1
                   when count(*) > 0 then 0.5
                 end, 0)
          into v_leave
          from (
            select case
                     when v_date = r.start_date
                          and coalesce(r.start_half, 'MORNING'::vizserve_pms_day_half) = 'AFTERNOON'
                       then 'AFTERNOON'
                     when v_date = r.end_date
                          and coalesce(r.end_half, 'AFTERNOON'::vizserve_pms_day_half) = 'MORNING'
                       then 'MORNING'
                     else 'WHOLE'
                   end as part
              from vizserve_pms_internal_requests r
             where r.requester_id = v_user
               and r.request_type = 'LEAVE'
               and r.status       = 'APPROVED'
               and r.start_date  <= v_date
               and r.end_date    >= v_date
          ) leave_parts;

        -- Never more than the day itself, so a day can only ever be removed
        -- once however many requests name it.
        v_expected := v_expected + 1 - v_leave;
      end if;

      v_date := v_date + 1;
    end loop;

    -- EXEMPTION 3. Nothing was expected, so nothing can be short — a week that
    -- is entirely holiday, or entirely covered by approved leave, owes nobody
    -- anything and `0 * anything` is not a threshold. No clamp is needed any
    -- more either: each day contributes `1 - coverage` and coverage never
    -- exceeds 1, so the day-by-day count cannot run negative the way the old
    -- per-request sum could.
    if v_expected > 0 then
      -- Rounded once, at the end. 4.5 days at a 450-minute day is 2025 minutes
      -- and rounding the day or the count first would move that.
      v_minimum := round(v_expected * v_day_minutes)::integer;

      if v_total < v_minimum then
        raise exception
          'That week is % short. You logged %, and % % at % each comes to %. Log the missing time, or file leave for any day you were away.',
          vizserve_pms_minutes_text(v_minimum - v_total),
          vizserve_pms_minutes_text(v_total),
          trim_scale(v_expected),
          case when v_expected = 1 then 'working day' else 'working days' end,
          vizserve_pms_minutes_text(round(v_day_minutes)::integer),
          vizserve_pms_minutes_text(v_minimum)
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- The write itself. The row was found and its status ruled on above; by here
  -- the only surviving existing row is a RETURNED one, and it has been through
  -- the same shortfall check a first submission gets.
  if v_existing.id is not null then
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

comment on function vizserve_pms_submit_timesheet_week(date) is
  'P7-05, with the P8-05 shortfall check. Hands a week to the department lead, '
  'refusing an empty week and one whose logged minutes fall short of the '
  'scheduled week — working days in the week, less approved leave counted ONCE '
  'PER DAY however many requests cover it, times '
  '(work_end - work_start - break). Exempt when no schedule is recorded, when '
  'the scheduled day is not positive, or when nothing was expected. The '
  'already-submitted and already-approved refusals come first, so a week that '
  'is no longer the caller''s to change says so instead of reporting a shortfall.';

-- No grant re-issued: `create or replace` preserves the existing privileges,
-- and the signature is unchanged so there is no new overload to grant. The
-- grants from 20260818110000_p7_05_timesheet_weeks.sql still apply.

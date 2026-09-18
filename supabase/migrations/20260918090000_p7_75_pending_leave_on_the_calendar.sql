-- P7-75 — requested leave appears on the shared calendar, before anybody decides.
--
-- ⚠️ THIS REVERSES P7-10's CENTRAL RULE, and the reversal is the point rather
-- than an oversight. `20260818130000_p7_10_leave_calendar.sql:34-39` reads:
--
--   "APPROVED ONLY, and that is a privacy rule rather than a display one. A
--    PENDING request is not yet a fact. Broadcasting it would tell the whole
--    company that someone has asked for time off before their own Team Leader
--    has seen it, which is how people learn to stop filing requests in the
--    system."
--
-- Amier, 18 Sep 2026: show it anyway, "so everyone know was it was someone on
-- leave". The argument that wins is planning, and it is the one the old note did
-- not weigh: a request filed a week ahead is invisible to the team for exactly
-- the days they are booking work into. Two people ask for the same Friday off
-- and neither can see the other until a lead has decided both. The calendar's
-- job is to stop that, and it could not do it for the window that matters most.
--
-- WHAT IS BEING ACCEPTED, stated plainly so nobody has to rediscover it: a
-- colleague now learns you asked for time off before your lead has answered, and
-- sees it again if the answer is no — the row simply disappears. That is a real
-- cost and it was the whole of P7-10's case. It is overruled deliberately, not
-- forgotten.
--
-- WHAT DOES NOT CHANGE, and must not:
--
--   * The visibility levels (P7-42). A HIDDEN type is still withheld from
--     everybody but its own requester, PENDING or APPROVED — RA 9262 §44 and
--     RA 9710 are statute, not preference, and a pending VAWC request is exactly
--     as confidential as a decided one. LABEL_HIDDEN still masks the label.
--   * REJECTED and WITHDRAWN stay off the calendar. A request that was answered
--     no is not an absence, and a withdrawn one never was.
--   * The projection. Still no `reason`, no `id`, no `department_id` — see the
--     note at the foot of this file.
--
-- THE NEW COLUMN IS `status`, NOT A BOOLEAN. The caller has to be able to say
-- "requested" rather than "away" in words, because state is never conveyed by
-- colour alone in this app, and a `is_pending` flag would have to be re-widened
-- the day a third state matters.
--
-- ⚠️ A SECOND CONSUMER READS THIS FUNCTION AND MUST NOT SEE PENDING ROWS.
-- `app/(app)/timesheet/team/page.tsx` uses it to excuse a missing timesheet week
-- — "this person was on leave, do not chase them". A requested week is not an
-- excused one, so that page filters to APPROVED itself. It is called out here
-- because the filter lives in TypeScript and this is the file somebody will be
-- reading when they wonder why.
--
-- APPLY BY HAND, in the Supabase SQL editor, pasting this file as it stands at
-- that moment — the same as every other P7 migration, none of which is recorded
-- in `supabase_migrations.schema_migrations`.

-- ---------------------------------------------------------------------------
-- DROP then CREATE, not CREATE OR REPLACE: Postgres refuses to change a
-- function's `returns table` in place, and the error it gives ("cannot change
-- return type of existing function") reads like a permissions problem if you
-- have not met it before. The same dance p7_42 had to do.
-- ---------------------------------------------------------------------------
drop function if exists vizserve_pms_leave_calendar(date, date);

create function vizserve_pms_leave_calendar(
  p_from date,
  p_to   date
)
returns table (
  user_id    uuid,
  full_name  text,
  start_date date,
  end_date   date,
  start_half vizserve_pms_day_half,
  end_half   vizserve_pms_day_half,
  type_label text,
  status     vizserve_pms_internal_request_status
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    r.requester_id as user_id,
    u.full_name,
    r.start_date,
    r.end_date,
    -- P7-16's semantics travel with the columns and are decoded by the caller:
    --   start_half MORNING   = the whole of that day
    --              AFTERNOON = from midday
    --   end_half   AFTERNOON = the whole of that day
    --              MORNING   = until midday
    r.start_half,
    r.end_half,
    case
      when t.calendar_visibility is null           -- pre-P7-12 row, no type
        or t.calendar_visibility = 'FULL'
        or r.requester_id = auth.uid()
      then t.label
    end as type_label,
    -- P7-75. APPROVED or PENDING_REVIEW, and the caller says which in words.
    r.status
  from vizserve_pms_internal_requests r
  join vizserve_pms_users u on u.id = r.requester_id
  -- LEFT join. `leave_type_id` is nullable on LEAVE filed before P7-12 existed,
  -- and an inner join would drop every one of those rows off the calendar.
  left join vizserve_pms_leave_types t on t.id = r.leave_type_id
  where r.request_type = 'LEAVE'
    -- P7-75. Was `= 'APPROVED'`. Listed rather than written as
    -- `not in ('REJECTED', 'WITHDRAWN')`, so a status added to the enum later
    -- has to be considered here before it can appear on everybody's calendar.
    and r.status in ('APPROVED', 'PENDING_REVIEW')
    -- OVERLAP, not containment. Leave running 28 Aug – 3 Sep belongs on both
    -- months' calendars; `start_date between p_from and p_to` would drop it
    -- from September, where the person is actually away.
    and r.start_date <= p_to
    and r.end_date   >= p_from
    -- A deactivated account's history stays in the table and should stay out of
    -- next month's calendar.
    and u.is_active
    -- P7-42. A HIDDEN type is withheld from everybody but its own requester.
    -- `is distinct from` rather than `<>` because the left join above yields
    -- NULL for a typeless historic row, and `null <> 'HIDDEN'` is NULL, which
    -- would silently drop exactly the rows the left join was added to keep.
    and (t.calendar_visibility is distinct from 'HIDDEN'
         or r.requester_id = auth.uid())
  -- Approved before requested on the same day, so a cell that can only show two
  -- names shows the two that are settled. `status` is an enum and PENDING_REVIEW
  -- is declared FIRST (p5_05:32-36), so this orders on the text deliberately
  -- rather than on the enum — declaration order here would put requested first.
  order by r.start_date, (r.status::text = 'APPROVED') desc, u.full_name;
$$;

-- SECURITY DEFINER runs as the owner, so anyone who can EXECUTE this reads
-- every leave row the visibility rules allow. That is the intent — it is an
-- out-of-office calendar — and it is why the function projects eight columns
-- rather than `select *`. `anon` is not granted: this is staff-facing, and the
-- client surfaces have no business knowing who is on leave.
--
-- THE REGRANT IS NOT OPTIONAL. The DROP above took the old grant with it, so
-- without these two lines every render reads `permission denied for function`
-- — which is a GRANT diagnosis and never a policy one.
revoke all on function vizserve_pms_leave_calendar(date, date) from public, anon;
grant execute on function vizserve_pms_leave_calendar(date, date) to authenticated;

comment on function vizserve_pms_leave_calendar(date, date) is
  'P7-10/P7-42/P7-75. LEAVE overlapping [p_from, p_to] that is APPROVED or '
  'still PENDING_REVIEW, for every active user, with the requester''s name, '
  'dates, halves and — where the type''s calendar_visibility allows it — its '
  'label. `status` says which of the two a row is; a caller that means "away" '
  'rather than "asked to be away" must filter on it. Never the reason. A HIDDEN '
  'type is returned only to its own requester, at either status.';

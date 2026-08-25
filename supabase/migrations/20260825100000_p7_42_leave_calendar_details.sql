-- ---------------------------------------------------------------------------
-- P7-42 — the leave calendar learns halves and (some) types.
--
-- WHAT THIS REVERSES, AND WHY THAT IS ALLOWED.
--
-- Three migrations went out of their way to say the calendar would not learn
-- these columns:
--
--   p7_12 (leave types)   "does NOT learn the type. Four of the eight types in
--                          the list above are disclosures in their own right."
--   p7_16 (halves)        "does not learn the halves. A calendar that rendered
--                          halves would be making a scheduling claim."
--   p7_41 (VAWC)          "the strongest argument yet for keeping it that way."
--
-- Those notes were right about the DANGER and wrong about the REMEDY. They
-- treated "the type" as one thing, so protecting the sensitive members meant
-- withholding all nine. But a colleague hovering a name genuinely needs to know
-- whether somebody is on a planned vacation or back after lunch, and answering
-- that does not require publishing anybody's gynaecological surgery.
--
-- So the type is no longer one thing. `calendar_visibility` splits it into
-- three, PER TYPE, and the sensitive members are handled by name rather than by
-- withholding the column from everybody:
--
--   FULL          name · real label · dates and halves
--   LABEL_HIDDEN  name · "On leave" · dates and halves   — you know not to
--                 expect them; you do not learn why
--   HIDDEN        nothing. The row never leaves this function
--
-- P7-16's scheduling objection is answered differently. The halves ship at
-- every level, because a tooltip reading "28 Aug, morning only" is not a claim
-- that the person is available in the afternoon — it is the span the requester
-- actually filed, the same fact the DTR and the payroll export have been
-- reading since P7-16.
--
-- THE REQUESTER IS EXEMPT FROM BOTH RULES. `auth.uid()` still resolves inside a
-- SECURITY DEFINER function — it reads the JWT claim, not the current role — so
-- your own leave appears on your own calendar in full at every level. Somebody
-- being protected from their colleagues should not also be hidden from
-- themselves.
--
-- APPLY BY HAND, in the Supabase SQL editor, pasting this file as it stands at
-- that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The visibility level.
--
-- AN ENUM RATHER THAN TWO BOOLEANS. `is_hidden` + `is_label_hidden` admits the
-- pair (hidden = true, label_hidden = false), which means nothing, and every
-- reader of the table would have to know which flag outranks the other. Three
-- named states in declaration order say it once.
--
-- Prefixed `vizserve_pms_`, like every other type in this schema. Guarded so a
-- re-paste of this file is a no-op rather than an error — the same reason
-- p7_41 used ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'vizserve_pms_leave_calendar_visibility'
  ) then
    create type vizserve_pms_leave_calendar_visibility
      as enum ('FULL', 'LABEL_HIDDEN', 'HIDDEN');
  end if;
end
$$;

alter table vizserve_pms_leave_types
  add column if not exists calendar_visibility
    vizserve_pms_leave_calendar_visibility not null default 'FULL';

comment on column vizserve_pms_leave_types.calendar_visibility is
  'P7-42. How this type appears on the shared leave calendar to somebody who is '
  'not the requester. FULL: name, label, dates. LABEL_HIDDEN: name and dates, '
  'the label reads "On leave". HIDDEN: the row is not returned at all — the '
  'absence itself is withheld. Defaults to FULL so a type added later is only '
  'restricted when somebody says so.';

-- ---------------------------------------------------------------------------
-- 2. The list, decided by Amier on 25 Aug 2026.
--
-- HIDDEN is two types, and both are statutory confidences rather than matters
-- of taste. RA 9262 §44 makes VAWC records confidential and attaches a penalty
-- to disclosing them; Special Leave for Women (RA 9710) is gynaecological
-- surgery. Neither can be inferred from an absence nobody can see, which is the
-- point of hiding the row rather than only the label.
--
-- LABEL_HIDDEN is Maternity. The team plans around a months-long absence, so
-- hiding the row would be a lie the calendar could not sustain, and the label
-- adds nothing they will not learn anyway.
--
-- SICK STAYS FULL. It was on the shortlist and was taken off deliberately — a
-- sick day is the single absence a team most needs to see, it is the ordinary
-- case rather than the sensitive one, and masking it would mean most of the
-- calendar read "On leave" and the whole feature was worth less than the
-- `title` attribute it replaced.
--
-- Written as two statements keyed on `code` rather than one CASE, so applying
-- this to a database where an admin has since changed one level by hand does
-- not quietly revert the other.
-- ---------------------------------------------------------------------------
update vizserve_pms_leave_types
   set calendar_visibility = 'HIDDEN'
 where code in ('SPECIAL_WOMEN', 'VAWC')
   and calendar_visibility <> 'HIDDEN';

update vizserve_pms_leave_types
   set calendar_visibility = 'LABEL_HIDDEN'
 where code = 'MATERNITY'
   and calendar_visibility <> 'LABEL_HIDDEN';

-- ---------------------------------------------------------------------------
-- 3. The function.
--
-- DROP then CREATE, not CREATE OR REPLACE: Postgres refuses to change a
-- function's `returns table` in place, and the error it gives ("cannot change
-- return type of existing function") reads like a permissions problem if you
-- have not met it before.
--
-- Everything that is not about the three new columns is unchanged — the overlap
-- predicate, APPROVED only, `u.is_active`, and the ordering.
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
  type_label text
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
    end as type_label
  from vizserve_pms_internal_requests r
  join vizserve_pms_users u on u.id = r.requester_id
  -- LEFT join. `leave_type_id` is nullable on LEAVE filed before P7-12 existed,
  -- and an inner join would drop every one of those rows off the calendar.
  left join vizserve_pms_leave_types t on t.id = r.leave_type_id
  where r.request_type = 'LEAVE'
    and r.status = 'APPROVED'
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
  order by r.start_date, u.full_name;
$$;

-- SECURITY DEFINER runs as the owner, so anyone who can EXECUTE this reads
-- every approved leave row the visibility rules allow. That is the intent — it
-- is an out-of-office calendar — and it is why the function projects seven
-- columns rather than `select *`. `anon` is not granted: this is staff-facing,
-- and the client surfaces have no business knowing who is on leave.
--
-- THE REGRANT IS NOT OPTIONAL. The DROP above took the old grant with it, so
-- without these two lines every render reads `permission denied for function`
-- — which is a GRANT diagnosis and never a policy one.
revoke all on function vizserve_pms_leave_calendar(date, date) from public, anon;
grant execute on function vizserve_pms_leave_calendar(date, date) to authenticated;

comment on function vizserve_pms_leave_calendar(date, date) is
  'P7-10/P7-42. Approved LEAVE overlapping [p_from, p_to], for every active '
  'user, as name, dates, halves and — where the type permits it — the type '
  'label. SECURITY DEFINER because RLS cannot withhold a single column: the '
  'reason stays private, the absence does not. Per-type exceptions live in '
  'vizserve_pms_leave_types.calendar_visibility; the requester is exempt from '
  'them on their own rows.';

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- `reason` and `decision_reason` are still withheld, and they are still the
-- whole reason this function exists. Somebody's medical appointment or family
-- emergency is between them and the person deciding the request. Nothing in
-- this migration brings either one nearer to a calendar cell.
--
-- `id` is still withheld: nothing may be looked up or acted on from a calendar
-- cell. `department_id` is still withheld — single-tenant, everyone shares one
-- calendar, and a department name beside a person's name is an org chart
-- nobody asked this widget for.
--
-- PENDING IS STILL NOT HERE. A request that has not been decided is not yet a
-- fact, and surfacing it would tell the company somebody ASKED for time off
-- before their own team leader had seen it. Your own pending leave still
-- reaches you through the ordinary policy, so the page can show it to you and
-- to nobody else.
--
-- THE CALENDAR IS NOW INCOMPLETE ON PURPOSE, and this is the sentence the next
-- person to read this file needs. A HIDDEN type means a colleague will believe
-- that person is in the office when they are not. That is the accepted price of
-- RA 9262 §44 and RA 9710, it is not a bug, and it must not be "fixed" by
-- widening the predicate. The absence is still fully visible where the question
-- is actually asked — /approvals for the deciding lead, and the DTR and the
-- payroll export, all of which read `vizserve_pms_internal_requests` through
-- its ordinary policy and are untouched by this file.
--
-- THERE IS NO ADMIN SCREEN for `calendar_visibility`. `/admin` holds holidays,
-- settings and users; leave types have never had one. Changing a level after
-- this migration is an UPDATE in the SQL editor. Stated rather than left to be
-- discovered.
-- ---------------------------------------------------------------------------

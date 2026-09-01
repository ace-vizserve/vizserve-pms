-- ---------------------------------------------------------------------------
-- P7-53 — the leave audit gains filters, and a second mode.
--
-- Asked for on 1 Sep 2026. The audit PDF prints EVERYBODY, WHOLE-YEAR, ALL
-- TYPES, ALWAYS — one argument, p_year. HR wanted to answer narrower questions:
-- one person, one department, one leave type, an arbitrary date range.
--
-- ⚠️ TWO MODES, TWO FUNCTIONS, DELIBERATELY.
--
--   Mode A `vizserve_pms_leave_report`  — person x leave-type, WITH allocation.
--                                         The annual balance audit; today's
--                                         document, now filterable.
--   Mode B `vizserve_pms_leave_taken`   — one row per leave REQUEST in an
--                                         arbitrary window, WITHOUT allocation.
--
-- Not one function with a mode flag. They return genuinely different shapes,
-- and a single returns-table covering both would have half its columns null in
-- either mode — which is the shape that makes a report quietly wrong. Mode B
-- has NO allocation column on purpose: allocation is annual, so a
-- range-scoped "remaining" would be a lie with a number next to it.
--
-- ⚠️ MODE A IS DROPPED AND RECREATED, NOT REPLACED. Adding defaulted parameters
-- via `create or replace` produces a SECOND OVERLOAD rather than a new
-- signature, and rpc("vizserve_pms_leave_report", { p_year }) then fails as
-- ambiguous. The drop takes the grants with it, so they are re-issued below —
-- the same dance p7_42:196-197 had to do to vizserve_pms_leave_calendar.
--
-- ⚠️ A MEMBER CAN NOW PRINT THEIR OWN RECORD. This amends D30, which said a
-- member gets "an empty set rather than an error". The `u.id = auth.uid()`
-- branch is new in both functions. Nothing else about D30 changes: the scope
-- is still stated on the page, and leavers are still included and flagged.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Apply AFTER 20260901090000_p7_52_hr_capability.sql — both
-- functions below call vizserve_pms_is_hr(), which that file creates.
-- ---------------------------------------------------------------------------

drop function if exists vizserve_pms_leave_report(integer);


-- ---------------------------------------------------------------------------
-- MODE A — the annual balance audit, filterable.
--
-- FILTER SEMANTICS, and they are the same in both functions: null means NO
-- FILTER, i.e. everything the caller may see. It never means "an empty set".
-- The caller-side schema refuses `[]` for the same reason — an empty array
-- reads as "none selected" and would render a blank PDF that looks like a
-- broken export rather than an answer.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_leave_report(
  p_year            integer default null,
  p_user_ids        uuid[] default null,
  p_department_ids  uuid[] default null,
  p_leave_type_ids  uuid[] default null
)
returns table (
  user_id         uuid,
  full_name       text,
  email           text,
  is_active       boolean,
  department_name text,
  leave_type_id   uuid,
  code            text,
  label           text,
  sort_order      integer,
  days_allocated  numeric,
  days_used       numeric,
  days_remaining  numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_caller uuid := auth.uid();
  -- Manila, for the reason the summary function gives: on 1 January a UTC
  -- server is still in December, and December is exactly when this is run.
  v_year   integer := coalesce(
              p_year,
              extract(year from (now() at time zone 'Asia/Manila'))::integer
            );
begin
  if v_caller is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    u.id,
    u.full_name,
    u.email::text,
    u.is_active,
    d.name,
    lt.id,
    lt.code,
    lt.label,
    lt.sort_order,
    coalesce(b.days_allocated, 0)::numeric,
    coalesce(taken.used, 0)::numeric,
    (coalesce(b.days_allocated, 0) - coalesce(taken.used, 0))::numeric
  from vizserve_pms_users u
  left join vizserve_pms_departments d on d.id = u.primary_department_id

  -- CROSS JOIN, deliberately: every person is paired with every leave type, so
  -- a type nobody has touched still produces a 0/0 row. The caller decides what
  -- to print; a report that silently omitted a type would be indistinguishable
  -- from one where the type did not exist, and an auditor cannot tell those
  -- apart after the fact.
  cross join vizserve_pms_leave_types lt

  left join vizserve_pms_leave_balances b
         on b.leave_type_id = lt.id
        and b.user_id       = u.id
        and b.balance_year  = v_year

  left join lateral (
    select sum(
             vizserve_pms_leave_days(r.start_date, r.end_date, r.start_half, r.end_half)
           ) as used
      from vizserve_pms_internal_requests r
     where r.request_type  = 'LEAVE'
       -- Approved only, matching the summary function. A pending request is not
       -- yet a fact, and an audit table is the last place to start treating one
       -- as though it were.
       and r.status        = 'APPROVED'
       and r.requester_id  = u.id
       and r.leave_type_id = lt.id
       -- Attributed by START date, so leave spanning new year counts wholly to
       -- the year it began in. Same rule as the summary; stated in both places
       -- because a report and a screen disagreeing about one request is exactly
       -- the discrepancy an audit exists to catch.
       and extract(year from r.start_date) = v_year
  ) taken on true

  where
    -- The authority check, restated rather than delegated: SECURITY DEFINER
    -- bypasses the policies on every table above, so this IS the check.
    --
    -- P7-52 adds is_hr() (true for every admin, so is_admin() is kept only for
    -- readability of intent). P7-53 adds the self branch: a member printing
    -- their OWN record is not a scope escalation, it is the same figure
    -- /approvals already shows them. Amends D30.
    (
      vizserve_pms_is_admin()
      or vizserve_pms_is_hr()
      or vizserve_pms_manages_department(u.primary_department_id)
      or u.id = v_caller
    )

    -- The three filters. Each is inert when null, so an absent filter means
    -- "everything in scope" and can never narrow to nothing by accident.
    -- These sit INSIDE the authority clause's conjunction, never beside it:
    -- a filter narrows what you may already see and cannot widen it.
    and (p_user_ids       is null or u.id                    = any(p_user_ids))
    and (p_department_ids is null or u.primary_department_id = any(p_department_ids))
    and (p_leave_type_ids is null or lt.id                   = any(p_leave_type_ids))

    -- ⚠️ A RETIRED TYPE SURVIVES A TYPE FILTER. This clause keeps a retired
    -- type where it has history or an allocation, and filtering TO a retired
    -- type must still return those rows — the filter narrows the set, it must
    -- never resurrect the is_active test. An auditor filtering to a type that
    -- was retired mid-year is precisely the case this report exists for, and
    -- it is the one that would silently return nothing if the filter above
    -- were written as `and lt.is_active and ...`.
    and (lt.is_active or coalesce(b.days_allocated, 0) > 0 or coalesce(taken.used, 0) > 0)

    -- ACTIVE STAFF, PLUS ANYBODY WHO ACTUALLY TOOK LEAVE THAT YEAR.
    --
    -- Active-only would be the obvious filter and would quietly drop somebody
    -- who resigned in November — whose absences are part of the year being
    -- audited whether or not they are still on the payroll. Their rows carry
    -- `is_active = false` so the report can mark them rather than pretend.
    and (
      u.is_active
      or exists (
        select 1
          from vizserve_pms_internal_requests r2
         where r2.requester_id = u.id
           and r2.request_type = 'LEAVE'
           and r2.status       = 'APPROVED'
           and extract(year from r2.start_date) = v_year
      )
    )

  order by u.full_name, u.id, lt.sort_order, lt.label;
end;
$$;

-- Re-issued because the DROP above took the originals with it.
revoke all on function vizserve_pms_leave_report(integer, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function vizserve_pms_leave_report(integer, uuid[], uuid[], uuid[]) to authenticated;

comment on function vizserve_pms_leave_report(integer, uuid[], uuid[], uuid[]) is
  'P7-34, filterable since P7-53. Mode A of the leave audit: one row per person '
  'per leave type for one year — allocated, used and remaining. Scoped to what '
  'the caller leads, plus their own record (P7-53, amending D30); HR and admin '
  'get everyone. Null filter means no filter. Includes leavers who took leave '
  'in the year, flagged by is_active.';


-- ---------------------------------------------------------------------------
-- MODE B — leave actually taken in an arbitrary window.
--
-- One row per approved LEAVE request OVERLAPPING the window, never contained by
-- it — the same rule as vizserve_pms_leave_calendar (p7_42:170-174). Leave
-- running 28 Aug to 3 Sep belongs in a September report, because the person is
-- genuinely away in September.
--
-- ⚠️ THE CLIPPING RULE IS THE SHARP EDGE OF THIS WHOLE MIGRATION, and it is
-- worth reading twice.
--
-- Days are counted for the OVERLAP, not for the request — otherwise a five-day
-- request straddling the window boundary contributes five days to a report
-- covering two of them. So the dates handed to vizserve_pms_leave_days are
-- greatest(start, p_from) and least(end, p_to).
--
-- But the half-day markers describe the REQUEST'S OWN ENDS, and once a date has
-- been clipped it is no longer an end. A request that finishes on an AFTERNOON
-- half-day, clipped by a window that ends before it, must be counted as running
-- to a FULL day at the clip — the person really is away all of that day. Carry
-- the marker across and the total silently loses half a day per clipped
-- request, in a document that gets signed and filed.
--
-- Hence: pass the real marker only when the corresponding end is INSIDE the
-- window, and the neutral whole-day marker otherwise. MORNING is a whole first
-- day and AFTERNOON a whole last one — the asymmetry P7-16 established and
-- which vizserve_pms_leave_days already defaults to.
--
-- The coalesce is not decoration: start_half and end_half are NULLABLE
-- (p7_16:28-29), and a null reaching the case would carry a null out of it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_leave_taken(
  p_from            date,
  p_to              date,
  p_user_ids        uuid[] default null,
  p_department_ids  uuid[] default null,
  p_leave_type_ids  uuid[] default null
)
returns table (
  user_id         uuid,
  full_name       text,
  email           text,
  is_active       boolean,
  department_name text,
  leave_type_id   uuid,
  code            text,
  label           text,
  sort_order      integer,
  request_id      uuid,
  start_date      date,
  end_date        date,
  counted_from    date,
  counted_to      date,
  start_half      text,
  end_half        text,
  is_clipped      boolean,
  days            numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- Both dates are required. Unlike Mode A's year there is no sensible default
  -- for an arbitrary window, and a silently-defaulted range on an audit
  -- document is worse than an error.
  if p_from is null or p_to is null then
    raise exception 'Give both a start and an end date.'
      using errcode = 'check_violation';
  end if;

  if p_to < p_from then
    raise exception 'The end date cannot be before the start date.'
      using errcode = 'check_violation';
  end if;

  return query
  select
    u.id,
    u.full_name,
    u.email::text,
    u.is_active,
    d.name,
    lt.id,
    lt.code,
    lt.label,
    lt.sort_order,
    r.id,
    r.start_date,
    r.end_date,
    greatest(r.start_date, p_from),
    least(r.end_date, p_to),
    coalesce(r.start_half, 'MORNING'::vizserve_pms_day_half)::text,
    coalesce(r.end_half, 'AFTERNOON'::vizserve_pms_day_half)::text,
    (r.start_date < p_from or r.end_date > p_to),
    vizserve_pms_leave_days(
      greatest(r.start_date, p_from),
      least(r.end_date, p_to),
      case when r.start_date >= p_from
           then coalesce(r.start_half, 'MORNING'::vizserve_pms_day_half)
           else 'MORNING'::vizserve_pms_day_half
      end,
      case when r.end_date <= p_to
           then coalesce(r.end_half, 'AFTERNOON'::vizserve_pms_day_half)
           else 'AFTERNOON'::vizserve_pms_day_half
      end
    )::numeric
  from vizserve_pms_internal_requests r
  join vizserve_pms_users u on u.id = r.requester_id
  join vizserve_pms_leave_types lt on lt.id = r.leave_type_id
  left join vizserve_pms_departments d on d.id = u.primary_department_id

  where r.request_type = 'LEAVE'
    -- Approved only. Same rule as Mode A and the summary function.
    and r.status = 'APPROVED'

    -- OVERLAP, not containment — see the header.
    and r.start_date <= p_to
    and r.end_date   >= p_from

    -- The same four-branch authority check as Mode A, restated for the same
    -- reason: SECURITY DEFINER bypasses every policy above this line.
    and (
      vizserve_pms_is_admin()
      or vizserve_pms_is_hr()
      or vizserve_pms_manages_department(u.primary_department_id)
      or u.id = v_caller
    )

    -- Scoped on the USER'S CURRENT DEPARTMENT, not r.department_id, which the
    -- request also carries. Mode A has no request to read and must use the
    -- user's; if this one used the request's, the two modes would disagree
    -- about which department somebody who transferred belongs to — and a pair
    -- of audit documents that disagree is exactly what an audit is run to
    -- rule out. The authority check above uses the same column for the same
    -- reason.
    and (p_user_ids       is null or u.id                    = any(p_user_ids))
    and (p_department_ids is null or u.primary_department_id = any(p_department_ids))
    and (p_leave_type_ids is null or lt.id                   = any(p_leave_type_ids))

  -- No is_active filter. Mode A has to reason about leavers because it walks
  -- the staff list; this walks REQUESTS, so a leaver appears exactly when they
  -- have leave in the window and is flagged by is_active like everyone else.
  order by u.full_name, u.id, r.start_date, lt.sort_order;
end;
$$;

revoke all on function vizserve_pms_leave_taken(date, date, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function vizserve_pms_leave_taken(date, date, uuid[], uuid[], uuid[]) to authenticated;

comment on function vizserve_pms_leave_taken(date, date, uuid[], uuid[], uuid[]) is
  'P7-53. Mode B of the leave audit: one row per approved LEAVE request '
  'overlapping an arbitrary window, with days counted for the OVERLAP and '
  'half-day markers dropped at a clipped end. No allocation column — '
  'allocation is annual, so a range-scoped remaining figure would be a lie. '
  'Same scope rules as Mode A.';

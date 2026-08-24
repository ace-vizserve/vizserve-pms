-- ---------------------------------------------------------------------------
-- P7-34 — the leave audit report: everybody's used and unused days, one query.
--
-- Asked for on 24 Aug 2026: run it in December, before January, to see how much
-- unused leave each person is carrying so bonuses can be worked out. That is an
-- audit document — it gets printed, signed and filed — which is why the caller
-- turns it into a PDF rather than a screen.
--
-- WHY A SECOND FUNCTION rather than calling `vizserve_pms_leave_balance_summary`
-- once per person: that one exists to answer "what is MY balance" and does an
-- authority check per call. Looping it over thirty staff would be thirty round
-- trips and thirty checks to produce one table. This does the whole set in one
-- pass, with the scope decided once.
--
-- SCOPE IS BY WHAT THE CALLER LEADS, not a flag. An admin gets everybody; a
-- team leader or manager gets the departments they manage and nobody else. A
-- member gets nothing at all — not an error, an empty set, because "you lead no
-- departments" is a true answer to this question rather than a failure. That is
-- the same shape `vizserve_pms_manages_department` already gives every list in
-- this app, and it means the report cannot become a way around it.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_leave_report(p_year integer default null)
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
    (vizserve_pms_is_admin() or vizserve_pms_manages_department(u.primary_department_id))

    -- A retired type is still reported where it has history or an allocation.
    -- Dropping it would lose leave that was genuinely taken under it.
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

-- `anon` is not granted. Nothing client-facing has any business with this, and
-- a member calling it gets an empty set rather than an error — see the header.
revoke all on function vizserve_pms_leave_report(integer) from public, anon;
grant execute on function vizserve_pms_leave_report(integer) to authenticated;

comment on function vizserve_pms_leave_report(integer) is
  'P7-34. One row per person per leave type for one year: allocated, used and '
  'remaining. Scoped to what the caller leads — admin gets everyone, a lead '
  'gets their departments, a member gets an empty set. Includes leavers who '
  'took leave in the year, flagged by is_active.';

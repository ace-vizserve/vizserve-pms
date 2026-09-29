-- ---------------------------------------------------------------------------
-- P14-01 — the Business Manager tick.
--
-- Asked for on 29 Sep 2026. A Business Manager MONITORS: they see every
-- department's work and are told when an approval ends, and they DECIDE
-- NOTHING. Amier Ordonez is the first holder, and he is also the Team Leader of
-- VizBytes — which is why this is a TICK and not a rung.
--
--     member -> team_leader -> manager -> owner (CEO)   rank    (the ladder)
--     Admin                                             tick    (own department)
--     HR                                                tick    (company-wide)
--     Business Manager                                  tick    (company-wide, read-only)
--
-- ⚠️ NOT A ROLE, for the reason D33 gave HR and P8-01 gave Admin. The enum is a
-- total order compared with `>=`; a person holds one value. "Team Leader of
-- VizBytes AND Business Manager" cannot be one value, and a rung for "sees
-- everything, approves nothing" would sit ABOVE team_leader in visibility and
-- BELOW it in authority, which no slot on a total order can express.
--
-- ⚠️ THIS FILE GRANTS NOBODY ANYTHING. It adds the column (default false) and
-- the predicate. No policy consults the predicate yet; the monitoring reads and
-- the "approval ended" email are follow-ups, each widening one policy at a
-- time, visibly — never through vizserve_pms_manages_department, which is
-- approval authority and must stay untouched (see p8_01b §7).
--
-- No enum change, so no 55P04 split: one file, one paste.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor. Paste BEFORE deploying the code
-- that ships with it: /admin/users selects this column, and PostgREST rejects a
-- select naming an unknown column whole.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_users
  add column if not exists is_business_manager boolean not null default false;

comment on column vizserve_pms_users.is_business_manager is
  'P14-01. Company-wide MONITORING: read every department, receive an email when '
  'any approval ends. Confers NO approval rights. Orthogonal to role, like is_hr '
  'and is_dept_admin — a Team Leader may hold it. Only an owner can set it. Read '
  'it through vizserve_pms_is_business_manager(), never directly.';

-- NOT mirrored into auth metadata, for the reason p8_01b gave is_dept_admin:
-- nothing may route on user_metadata (D18).


-- Shape copied from vizserve_pms_is_hr() (p8_01b §4) exactly, owner branch
-- included: an owner already sees everything, so every future widening of a
-- policy to this function is a strict widening, never a transfer.
create or replace function vizserve_pms_is_business_manager()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_users u
     where u.id = auth.uid()
       and u.is_active
       and 'vizserve-pms' = any(u.app_access)
       and (u.is_business_manager or u.role >= 'owner')
  )
$$;

revoke all on function vizserve_pms_is_business_manager() from public, anon;
grant execute on function vizserve_pms_is_business_manager() to authenticated;

comment on function vizserve_pms_is_business_manager() is
  'P14-01. True for an active, app-accessible user carrying is_business_manager, '
  'and for any owner. Read-only oversight — NOT approval authority; do not wire it '
  'into vizserve_pms_manages_department. NO POLICY CONSULTS THIS YET.';

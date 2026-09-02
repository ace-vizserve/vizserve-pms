-- ---------------------------------------------------------------------------
-- P7-66 — A FORM SAYS WHAT IT IS FOR.
--
-- Amier, 2 Sep 2026. Every form in this system is a client request: submit →
-- mint a reference number → the Team Leader queue → Gate 1 → a task. That is
-- right for a client and wrong for an Employee Engagement form — a pulse
-- survey, a kudos nomination, a sign-up — which has no client, no SLA and
-- nothing to approve.
--
-- `is_public` (20260729100000_p1_01_forms.sql:37) already carries half of that
-- distinction and has done since Phase 1: "true for client forms, false for
-- internal". It has never had a UI control, so every form ever created here is
-- `true`. What it cannot do is SAY WHAT THE FORM IS — it is a reachability
-- flag, and reading intent out of it means every screen re-deriving the same
-- meaning from a boolean. So the intent becomes its own column and the boolean
-- becomes a consequence of it.
--
-- ⚠️ THE TWO ARE TIED BY A CHECK, NOT BY CONVENTION. `is_public = (purpose =
-- 'CLIENT_REQUEST')` is the whole security argument of this change: an
-- engagement form that was accidentally `is_public = true` would be reachable
-- at /request/<slug> with no session at all, because
-- `vizserve_pms_get_public_form`'s where clause is `slug and is_public and
-- is_active` and knows nothing about purpose. The constraint makes that state
-- unrepresentable rather than merely unlikely, and it is why the server derives
-- `is_public` from `purpose` and the client is never allowed to send it.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it
-- stands at that moment. THIS FILE IS UNAPPLIED AS SHIPPED. Every P7 migration
-- landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`. RUN THE PRE-FLIGHT BLOCK BELOW
-- FIRST.
--
-- This file is re-runnable: the type is created only if absent, the column is
-- added `if not exists`, and the constraint is added only if it is not already
-- there.
--
-- ⚠️ THE APPLICATION CODE IS AHEAD OF THIS FILE. `lib/database.types.ts`
-- declares `purpose`, and /forms, /forms/new and /forms/[id] all select and
-- write it. Until this runs, those three screens fail with
-- `column vizserve_pms_forms.purpose does not exist` (42703) — which is a
-- missing COLUMN and never a grant or an RLS problem, whatever the message
-- looks like at 5pm.
--
-- Back-out:
--   alter table vizserve_pms_forms drop constraint vizserve_pms_forms_purpose_matches_public;
--   alter table vizserve_pms_forms drop column purpose;
--   drop type vizserve_pms_form_purpose;
-- in that order — the constraint and the column both depend on the type.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — RUN THIS FIRST, ON ITS OWN, AND DO NOT APPLY THE FILE UNTIL IT
-- RETURNS ZERO.
--
-- Measured 2 Sep 2026: 4 forms, all `is_public = true` and all published; 10
-- requests; zero `vizserve_pms_form_fields` rows. On that data the answer is
-- 0 and the CHECK below is satisfied by the column default alone.
--
-- It is asked anyway because the constraint is added VALIDATING — Postgres
-- checks every existing row before it will accept it — so a single row where
-- `is_public` is not true aborts the whole file with
-- `check constraint … is violated by some row`, naming no row. Better to see
-- the count than the abort.
--
-- Nothing here is destructive; it only reports.
-- ===========================================================================
--
-- --- ANY FORM THAT IS NOT PUBLIC ------------------------------------------
-- Every row gets `purpose = 'CLIENT_REQUEST'` from the default below, and the
-- CHECK then demands `is_public = true` of it. So this counts exactly the rows
-- the constraint would refuse.
--
-- select count(*) from vizserve_pms_forms where is_public <> true;
--
-- A NON-ZERO RESULT MEANS SOMEBODY BUILT AN INTERNAL FORM BEFORE THIS COLUMN
-- EXISTED — through the API or the SQL editor, since no screen has ever
-- offered the choice. Do not "fix" it by flipping `is_public` to true: that
-- would put a form somebody deliberately kept off the internet ONTO the
-- internet at /request/<slug>, which is the exact failure this constraint is
-- here to prevent. List them, decide what each one is, and set
-- `purpose = 'EMPLOYEE_ENGAGEMENT'` on those that are internal — as a separate
-- statement AFTER the column is added and BEFORE the constraint is:
--
-- select id, slug, name, is_public, is_active, created_at
--   from vizserve_pms_forms where is_public <> true order by created_at;
--
-- `is_public` is also nullable in neither direction — it is `not null default
-- true` — so `<> true` is exactly `= false` here and cannot hide a null.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The type.
--
-- A BRAND-NEW ENUM IS USABLE IN THE SAME TRANSACTION as the column that
-- references it. Only ADDING A VALUE to an existing enum has to sit in a
-- transaction of its own, which is why this file is one paste rather than two.
--
-- An enum rather than a lookup table, on the P7-12 test: these two are
-- STRUCTURAL, not policy data somebody edits. `CLIENT_REQUEST` is the only one
-- that is public, mints a reference number, carries an SLA and a client
-- approval window, and routes through Gate 1. A third value would mean new
-- columns, new screens and a new lifecycle — which is precisely the test.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'vizserve_pms_form_purpose') then
    create type vizserve_pms_form_purpose as enum ('CLIENT_REQUEST', 'EMPLOYEE_ENGAGEMENT');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- The column.
--
-- `default 'CLIENT_REQUEST'` is what makes this safe on live data: the four
-- existing forms ARE client requests, every one of them is public and
-- published, and the default records that fact without a backfill statement
-- that could get the direction wrong.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_forms
  add column if not exists purpose vizserve_pms_form_purpose not null default 'CLIENT_REQUEST';

comment on column vizserve_pms_forms.purpose is
  'P7-66. What the form is FOR, and the source of truth for is_public. '
  'CLIENT_REQUEST: a public link, no login, Gate 1, a reference number, an SLA. '
  'EMPLOYEE_ENGAGEMENT: staff fill it in signed in and the answers are '
  'collected, not approved — the reference prefix, SLA, default list and client '
  'approval window are meaningless on one and are not asked for. '
  'is_public is DERIVED from this server-side and tied to it by '
  'vizserve_pms_forms_purpose_matches_public; never write the two separately.';


-- ---------------------------------------------------------------------------
-- The tie.
--
-- Guarded rather than plain `add constraint`, so re-running the file does not
-- fail with `constraint … already exists` — there is no
-- `add constraint if not exists`.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'vizserve_pms_forms_purpose_matches_public'
       and conrelid = 'vizserve_pms_forms'::regclass
  ) then
    alter table vizserve_pms_forms
      add constraint vizserve_pms_forms_purpose_matches_public
      check (is_public = (purpose = 'CLIENT_REQUEST'));
  end if;
end
$$;

-- No table grant and no policy change. Privileges on `vizserve_pms_forms` are
-- held at table level (20260729110000_p0_06_grants.sql) and a new column
-- inherits them, and the five P1 policies
-- (20260729100300_p1_rls_policies.sql:26-54) scope on `department_id` and
-- `created_by`, neither of which this touches. An engagement form is therefore
-- created, read and updated by exactly the people a client form is: a team
-- leader for the departments they lead, plus the author while it is unrouted.
-- Stated because "permission denied for table" is a GRANT diagnosis and never
-- an RLS one — and because a new column that silently needed neither is worth
-- writing down rather than rediscovering.

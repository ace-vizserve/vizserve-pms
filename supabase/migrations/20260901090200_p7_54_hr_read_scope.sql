-- ---------------------------------------------------------------------------
-- P7-54 — the read scope P7-52 needed and did not grant.
--
-- ⚠️ WITHOUT THIS, EVERY HR SCREEN SHOWS AN HR MEMBER ONLY THEMSELVES, and it
-- does so SILENTLY — a failing policy returns zero rows, never an error. P7-52
-- widened the tables HR WRITES (leave balances, leave types, holidays) and
-- missed the tables HR READS.
--
-- `vizserve_pms_users` is the one that matters most. Its SELECT policies are:
--
--     using (id = auth.uid())                                  -- yourself
--     using (vizserve_pms_manages_department(primary_department_id))
--     using (vizserve_pms_is_admin())   -- via the `for all` write policy
--
-- An ADMIN passes the second (manages_department returns true for admins), so
-- nobody noticed. An HR MEMBER who leads no department passes only the first,
-- so /hr/balances renders a grid of one person, /hr/reports offers a staff
-- picker containing only them, and /hr/attendance reports on nobody. All three
-- look like empty screens rather than like a permissions problem.
--
-- ⚠️ THESE ARE ADDITIVE POLICIES, NOT REPLACEMENTS. Multiple permissive SELECT
-- policies on one table are OR-ed, so adding a branch cannot narrow anybody's
-- existing access — and unlike P7-52's drop-and-create, there is no moment
-- where an existing policy is absent.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Apply AFTER 20260901090000_p7_52_hr_capability.sql, which
-- creates `vizserve_pms_is_hr()`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Staff records.
--
-- Read only — the write policy stays `vizserve_pms_is_admin()`, untouched, and
-- that is the line that stops HR appointing HR. HR can SEE the whole staff
-- list and can change nothing about it.
-- ---------------------------------------------------------------------------
create policy "users readable by HR"
  on vizserve_pms_users for select to authenticated
  using (vizserve_pms_is_hr());


-- ---------------------------------------------------------------------------
-- 2. Attendance records.
--
-- /hr/attendance counts working days with no punch, which requires reading the
-- punches of people HR does not lead. There is no narrower version of this
-- question: an absence is the ABSENCE of a row, so it cannot be computed from
-- a filtered set — a person whose rows are invisible is indistinguishable from
-- a person who never came in.
-- ---------------------------------------------------------------------------
create policy "dtr readable by HR"
  on vizserve_pms_dtr_entries for select to authenticated
  using (vizserve_pms_is_hr());


-- ---------------------------------------------------------------------------
-- 3. Internal requests — LEAVE, OVERTIME and the two time corrections ONLY.
--
-- ⚠️ REIMBURSEMENT IS DELIBERATELY EXCLUDED. D33 lists what HR does: set leave
-- balances, monitor leave and attendance, manage leave types and holidays, run
-- the leave audit. Money is not on that list, and a policy is the wrong place
-- to be generous — "HR can read every internal request" is easy to write, hard
-- to notice, and impossible to walk back once somebody has read one. If HR is
-- later given expenses, this predicate is the one line to change, and changing
-- it will be a decision somebody made rather than one nobody did.
--
-- Leave is needed twice over: /hr/attendance must tell an approved absence from
-- an unexplained one, and the audit's Mode B counts approved leave directly.
-- Overtime is needed because it moves the effective end of the day, so without
-- it a day that was agreed to run long reads as undertime.
--
-- ⚠️ THIS DOES EXPOSE THE TWO STATUTORY-CONFIDENCE LEAVE TYPES to HR — VAWC
-- (RA 9262 §44) and Special Leave for Women (RA 9710), which P7-42 hides from
-- the shared calendar entirely. That is correct and not an oversight: those
-- types are hidden from COLLEAGUES, and HR is the function that allocates them,
-- records them and answers for them. The calendar rule protects the person from
-- their team, not from HR.
-- ---------------------------------------------------------------------------
create policy "internal requests readable by HR"
  on vizserve_pms_internal_requests for select to authenticated
  using (
    vizserve_pms_is_hr()
    and request_type in (
      'LEAVE',
      'OVERTIME',
      -- P7-38's pair, and the P5-era pair they replaced. The old values are
      -- still in the enum and still on rows filed before 24 Aug; omitting them
      -- would make historical corrections invisible to the one function whose
      -- job is to look back over attendance.
      'TIME_IN_CORRECTION',
      'TIME_OUT_CORRECTION',
      'NO_TIME_IN',
      'NO_TIME_OUT'
    )
  );


-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT GRANTED.
--
--   vizserve_pms_audit_logs      — admin only. HR sees the consequences of
--                                  changes on their own screens; the trail of
--                                  who changed what is administration.
--   vizserve_pms_users (write)   — see above. The single reason HR cannot
--                                  escalate itself.
--   REIMBURSEMENT requests       — see the comment on policy 3.
--   vizserve_pms_app_settings    — already readable by every active user
--   vizserve_pms_holidays        — (grace_minutes and the holiday list are not
--   vizserve_pms_leave_types        secret), so neither needed a new policy.
--   vizserve_pms_departments
-- ---------------------------------------------------------------------------

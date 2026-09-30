-- P14-06 — DEPARTMENT ADMIN IS RETIRED (30 Sep 2026).
--
-- Decided by Ace: what the tick allowed — managing a department's forms, lists
-- and folders — is Team Leader and up. A Team Leader does it for the
-- departments ticked for them; Manager, Admin, Business Manager and CEO do it
-- everywhere; any member already makes lists and folders in their own
-- department (P11-07). The switch is gone from the user editor.
--
-- Clearing the ticks is what makes the removal real: a lingering tick would go
-- on granting a member form-building rights nobody can see or switch off.
-- The column and vizserve_pms_is_dept_admin() stay (policies reference them);
-- with every tick cleared the function answers only for the CEO branch.
--
-- ⚠️ APPLY BY HAND in the SQL editor. Never `db:push`.

update vizserve_pms_users
   set is_dept_admin = false
 where is_dept_admin;

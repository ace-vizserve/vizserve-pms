-- ---------------------------------------------------------------------------
-- P7-30 — revoking app access must close the department views too.
--
-- FOUND BY A TEST THAT WAS ALREADY THERE. `app-access.test.ts` asserts that one
-- revoke shuts the whole app:
--
--   "The gate is wired into `vizserve_pms_current_role()`, which every policy
--    funnels through — so one revoke shuts the whole app rather than needing a
--    policy edit per table and a new one remembered for every future table."
--
-- P7-17 added the first two policies that do NOT funnel through it. Both read
-- `vizserve_pms_my_department()` directly, and that function checks `is_active`
-- and nothing else:
--
--   has_app_access()   is_active AND 'vizserve-pms' = any(app_access)
--   my_department()    is_active                                        ← gap
--
-- So a user whose access had been revoked kept reading:
--
--   * `vizserve_pms_users`   — every active person in their department, by name
--                              and department. The test caught this one: it
--                              expected at most their own row and got three.
--   * `vizserve_pms_tasks`   — every non-personal task in their department,
--                              client work included. Nothing caught this one,
--                              because no test asked. It is the same function.
--
-- Neither is a leak to a stranger — it is bounded by the department the person
-- already belonged to, and revocation is usually somebody leaving rather than
-- somebody hostile. But "revoked" has to mean revoked, or the gate is a
-- suggestion, and the second hole would have gone on widening: every future
-- policy written against `my_department()` inherits it silently.
--
-- THE FIX IS ONE FUNCTION, deliberately. Adding `and has_app_access()` to each
-- POLICY would work today and would be the wrong shape: it is two edits now,
-- three the next time somebody writes a department-scoped policy, and the one
-- that gets forgotten is the bug. Putting it inside `my_department()` means a
-- revoked user simply has no department, and every policy phrased as
-- `… = vizserve_pms_my_department()` closes on its own — including ones not
-- written yet.
--
-- NULL IS WHAT DOES THE WORK. The function returns null rather than raising, so
-- `department_id = null` evaluates to null, which a policy treats as false. No
-- error, no permission-denied, no row — a working policy rather than a missing
-- grant, which is the distinction this codebase keeps.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it
-- stands at that moment.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_my_department()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.primary_department_id
    from vizserve_pms_users u
   where u.id = auth.uid()
     and u.is_active
     -- P7-30. The app-access gate, which P7-17 did not carry. Same test as
     -- `vizserve_pms_has_app_access()`, inlined rather than called: this
     -- function is read from a policy ON `vizserve_pms_users`, and both are
     -- SECURITY DEFINER reads of the same one row, so one statement is cheaper
     -- and cannot drift out of step with a second definer function.
     and 'vizserve-pms' = any(u.app_access)
$$;

-- `create or replace` on the same signature keeps the existing grant. Restated
-- so a hand-applied paste against a database that somehow lacks it still ends
-- up correct.
grant execute on function vizserve_pms_my_department() to authenticated;

comment on function vizserve_pms_my_department() is
  'P7-17, gated by P7-30. The caller''s own department, or null if they are '
  'inactive or not provisioned for this app. SECURITY DEFINER because it is '
  'read from a policy on vizserve_pms_users and would otherwise recurse. '
  'Returning null is what closes every department-scoped policy at once when '
  'access is revoked.';

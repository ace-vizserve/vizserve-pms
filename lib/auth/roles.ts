import type { VizservePmsUserRole } from "@/lib/database.types";

/**
 * The role hierarchy, with NO server-only import.
 *
 * Split out of `authorization.ts` because that module is `server-only` — it
 * resolves a session and reaches the database, and pulling it into a client
 * bundle is a build error by design. But the role ORDER is not a secret and not
 * a decision; it is a fact about the enum, and a role selector, a zod schema and
 * a nav filter all legitimately need it on the client.
 *
 * Duplicating the list instead would be the actual danger: two copies that drift
 * make `roleAtLeast` and the Postgres `>=` disagree, and that disagreement shows
 * up as a security bug rather than a type error.
 *
 * The decisions still live in `authorization.ts`. This is only the ordering.
 */

/**
 * Ascending authority. Mirrors the Postgres enum declaration order exactly.
 *
 * ⚠️ "admin" IS A DEAD RUNG AND MUST STAY IN THIS ARRAY. P8-01 moved what
 * `admin` meant — "oversees everything" — up to the new top value `owner`, and
 * promoted every existing row. No account holds "admin" any more and the role
 * picker no longer offers it (see ROLE_LABELS), but the value is still declared
 * in the Postgres enum: dropping an enum value means rebuilding the type on a
 * live database, which buys nothing. Delete it from here and every `indexOf`
 * below shifts by one against a `>=` in SQL that did not — which is the exact
 * disagreement the comment above warns produces a security bug rather than a
 * type error.
 */
export const ROLE_ORDER = ["member", "team_leader", "manager", "admin", "owner"] as const;

export type Role = VizservePmsUserRole;

/**
 * Roles are INCLUSIVE: owner ⊇ manager ⊇ team_leader ⊇ member (D15).
 * Always `>=`, never `===`. Amier is an owner who is also a TL; an equality
 * check would lock him out of his own approval queue.
 *
 * ⚠️ P8-01 made the `===` rule enforceable rather than merely advised. Every
 * `role === "admin"` in the app was true for the top rung until the top rung was
 * renamed, and would now be true for NOBODY — a whole class of silent
 * permission loss that `roleAtLeast` is immune to.
 */
export function roleAtLeast(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}

/**
 * P12-15 — DEPARTMENT SCOPE, AS A PURE PREDICATE.
 *
 * ⚠️ THIS IS `canAccessDepartment`'S BODY, MOVED, NOT A SECOND COPY OF IT.
 * `lib/auth/authorization.ts` still exports that name and still owns the
 * decision — it now delegates here, so there is exactly one reading of the rule
 * and no way for the two to drift. The whole reason this file exists (see the
 * header) is that the ORDER is a fact about the enum rather than a secret, and
 * so is "an owner reaches everything, everyone else needs the department in
 * their managed set".
 *
 * ⚠️ IT MOVED BECAUSE `waitingOnMe` HAD TO REACH THE BROWSER. Phase 4 moved
 * `/approvals` onto the query cache, so the row that decides whether to draw a
 * decision panel arrives in a client component — and `waitingOnMe` is the one
 * definition of "is this mine to decide", shared with the dashboard tile so the
 * count that sends somebody here and the list they land on cannot disagree.
 * Importing it from `approvals-queue-server.ts` pulled `authorization.ts`, and
 * with it `server-only`, into the browser bundle: a build failure the type
 * checker, eslint and vitest are all blind to (see the plan's Phase 3b note).
 *
 * ⚠️ AND IT IS STILL PRESENTATION. Every rule here is re-asked by
 * `vizserve_pms_may_decide_internal_stage`, by the tasks policies and by
 * `vizserve_pms_manages_department`. A mistake here draws the wrong button; it
 * cannot grant anything.
 *
 * ⚠️ `"owner"`, NOT `"admin"` — the dead rung must not unfilter anything. The
 * long version of why is on `canAccessDepartment` in `authorization.ts`.
 */
export function canAccessDepartmentScope(
  scope: { role: Role | null | undefined; managedDepartmentIds: readonly string[] },
  departmentId: string | null,
): boolean {
  if (roleAtLeast(scope.role, "owner")) return true;
  if (!departmentId) return false;
  return (
    roleAtLeast(scope.role, "team_leader") && scope.managedDepartmentIds.includes(departmentId)
  );
}

/**
 * P12-22 — THE DEPARTMENT-ADMIN CAPABILITY, AS A PURE PREDICATE.
 *
 * ⚠️ THIS IS `canAdminDepartment`'S BODY, MOVED, NOT A SECOND COPY OF IT — the
 * same arrangement `canAccessDepartmentScope` above records, for the same
 * reason and by the same precedent. `lib/auth/authorization.ts` still exports
 * that name, still owns the decision, and now delegates here, so there is one
 * reading of the rule and no way for the two to drift.
 *
 * ⚠️ IT MOVED BECAUSE `administersForm` HAD TO REACH THE BROWSER. Phase 6 moved
 * `/forms` onto the query cache, and that screen's whole subject is "which of
 * the forms I can READ are mine to ADMINISTER" — a question no row-level policy
 * can answer, because the difference is which question is being asked rather
 * than which rows exist (see `app/(app)/forms/administers.ts`). So the filter
 * runs beside the rows, in a client component. Importing it from
 * `authorization.ts` pulled `server-only` into the browser bundle: a build
 * failure the type checker, eslint and vitest are all blind to.
 *
 * ⚠️ AND IT IS STILL PRESENTATION. Every rule here is re-asked by
 * `vizserve_pms_is_dept_admin(uuid)`, by `assertCanEditForm` on every write and
 * by `forms updatable in scope` behind that. A mistake here draws the wrong
 * screen; it cannot grant anything.
 *
 * ⚠️ `primaryDepartmentId`, NOT `managedDepartmentIds`. A department admin is a
 * member of their department BY RANK and does not lead it. Reading the managed
 * set here would turn the tick into a second, invisible way of being a lead.
 *
 * ⚠️ AND IT IS NOT APPROVAL AUTHORITY. `canAccessDepartmentScope` mirrors
 * `vizserve_pms_manages_department`, which is what decides who may APPROVE, and
 * P8-01 deliberately left it alone. Two predicates, so the two questions can
 * never be answered by one edit.
 */
export type AdminScope = {
  role: Role | null | undefined;
  isDeptAdmin: boolean;
  primaryDepartmentId: string | null;
};

export function canAdminDepartmentScope(
  scope: AdminScope,
  departmentId: string | null,
): boolean {
  if (roleAtLeast(scope.role, "owner")) return true;
  /*
   * A null `departmentId` — a person with no department, or a row that has not
   * been assigned one — is false for everyone but an owner, which is the correct
   * reading of "administers no department". It matches the SQL, where the `=`
   * against null is null and therefore not true.
   */
  if (!departmentId) return false;
  return scope.isDeptAdmin && scope.primaryDepartmentId === departmentId;
}

/**
 * P12-22 — "MAY THIS PERSON RESHAPE THIS DEPARTMENT?", as a pure predicate.
 *
 * ⚠️ `canShapeDepartment`'S BODY, MOVED, on the same terms as the two above.
 * P8-01c's union of the two ways in:
 *
 *   A LEAD, through `canAccessDepartmentScope` — team_leader-or-above with the
 *   department in their managed set. The only route that also carries approval
 *   authority.
 *
 *   A DEPARTMENT ADMIN, through `canAdminDepartmentScope` — the P8-01 tick, on
 *   their own `primaryDepartmentId`, AT ANY RANK. A member holding it reshapes
 *   the team they belong to and approves nothing.
 *
 * ⚠️ AN `||`, AND THE TWO HALVES MUST STAY SEPARATE PREDICATES. The tempting
 * shortcut is to widen `canAccessDepartmentScope` itself, which would be one
 * edit instead of two — and would be the exact mistake
 * `20260903100100_p8_01b_admin_capability.sql` §7 forbids on the SQL side: that
 * predicate mirrors `vizserve_pms_manages_department`, which /approvals, the
 * leave policies and the timesheet queues consult to decide WHO MAY DECIDE.
 * Widening it would hand every department admin the power to approve their own
 * leave. This is a THIRD predicate reading both, so structure and approval can
 * never be confused again by an edit to either.
 */
export type ShapeScope = AdminScope & { managedDepartmentIds: readonly string[] };

export function canShapeDepartmentScope(
  scope: ShapeScope,
  departmentId: string | null,
): boolean {
  return (
    canAccessDepartmentScope(scope, departmentId) ||
    canAdminDepartmentScope(scope, departmentId)
  );
}

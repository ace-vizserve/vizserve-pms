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

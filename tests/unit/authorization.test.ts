import { describe, expect, it } from "vitest";

import {
  ROLE_ORDER,
  canAccessDepartment,
  canManageAnyDepartmentTree,
  canManageDepartmentTree,
  departmentPickerScope,
  departmentScopeFilter,
  departmentTreeScope,
  isCollaborationSpace,
  realtimeDepartmentScope,
  roleAtLeast,
  type AuthContext,
  type Role,
} from "@/lib/auth/authorization";

/**
 * P0-12 — the TypeScript half of the scope suite.
 *
 * These assert the decisions `lib/auth/authorization.ts` makes in isolation.
 * They cannot prove RLS; `tests/db/scope.test.ts` does that. Both are needed —
 * this layer decides whether a button renders, RLS decides whether the row
 * exists, and either one alone is a hole.
 */

const DEPT_A = "a1000000-0000-4000-8000-000000000001";
const DEPT_B = "a1000000-0000-4000-8000-000000000002";
const DEPT_C = "a1000000-0000-4000-8000-000000000003";
/** P13-01 -- "Collaboration Projects (All departments)". Nobody's team. */
const SHARED = "a1000000-0000-4000-8000-000000000005";

function context(overrides: Partial<AuthContext> & { role: Role }): AuthContext {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "test.someone@example.com",
    fullName: "Test Someone",
    // P7-45. Not an authorization input — it narrows the leave picker — but the
    // context carries it, so the factory has to supply a default.
    gender: null,
    // P7-52. Defaults to false so every existing case describes somebody who is
    // NOT HR — the HR cases opt in explicitly, and the ones below that pin the
    // role ladder keep testing only the ladder.
    isHr: false,
    // P8-01. The department-admin tick — orthogonal to `role`, exactly as
    // `isHr` is, and false unless a test says otherwise.
    isDeptAdmin: false,
    primaryDepartmentId: null,
    managedDepartmentIds: [],
    // P13-01. The collaboration spaces, EMPTY unless a test says otherwise —
    // so every case written before this existed describes a company with no
    // shared space, which is what it was testing.
    sharedDepartmentIds: [],
    ...overrides,
  };
}

describe("roleAtLeast — roles are inclusive (D15)", () => {
  it("mirrors the Postgres enum declaration order exactly", () => {
    // If these ever diverge, `role >= required` in SQL and `roleAtLeast` in TS
    // answer differently, and the difference shows up as a security bug rather
    // than a type error. Cheap assertion, expensive omission.
    // P8-01 appended `owner` and left `admin` in place as a DEAD RUNG — the
    // Postgres enum still declares it, because dropping an enum value means
    // rebuilding the type on a live database. Remove it from the array alone
    // and every index shifts against a `>=` in SQL that did not move.
    expect(ROLE_ORDER).toEqual(["member", "team_leader", "manager", "admin", "owner"]);
  });

  it("owner satisfies every floor", () => {
    // Was "admin satisfies every floor" until P8-01 moved that meaning up a
    // rung. Admin no longer does — nothing holds it, and every predicate in the
    // database now reads `>= owner`.
    for (const required of ROLE_ORDER) {
      expect(roleAtLeast("owner", required)).toBe(true);
    }
  });

  it("member satisfies only the member floor", () => {
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("member", "team_leader")).toBe(false);
    expect(roleAtLeast("member", "manager")).toBe(false);
    expect(roleAtLeast("member", "admin")).toBe(false);
  });

  it("is >= and not ===, so an owner still reaches a team_leader gate", () => {
    // The real case this protects: Amier is an owner who is also a TL. An
    // equality check locks him out of his own approval queue.
    expect(roleAtLeast("owner", "team_leader")).toBe(true);
    expect(roleAtLeast("manager", "team_leader")).toBe(true);
    // The dead rung still ORDERS above team_leader — `roleAtLeast` is a fact
    // about the enum and says nothing about what anything grants. What it must
    // not do is unlock a department; `dept-admin-capability.test.ts` pins that.
    expect(roleAtLeast("admin", "team_leader")).toBe(true);
  });

  it("treats a missing role as no authority rather than as a default", () => {
    expect(roleAtLeast(null, "member")).toBe(false);
    expect(roleAtLeast(undefined, "member")).toBe(false);
  });
});

describe("canAccessDepartment", () => {
  it("lets an owner reach every department, including ones they lead none of", () => {
    // Was `admin` until P8-01 finished. The predicate now asks for `>= owner`,
    // which is what every policy behind it asks for too — see the dead-rung case
    // in `dept-admin-capability.test.ts`.
    const owner = context({ role: "owner" });
    expect(canAccessDepartment(owner, DEPT_A)).toBe(true);
    expect(canAccessDepartment(owner, DEPT_C)).toBe(true);
  });

  it("requires the department to be in the managed set, not merely the role", () => {
    // This is the whole point of vizserve_pms_user_managed_departments. A TL of
    // VizBytes holding the team_leader role must not thereby reach VizMedia.
    const tl = context({ role: "team_leader", managedDepartmentIds: [DEPT_A] });
    expect(canAccessDepartment(tl, DEPT_A)).toBe(true);
    expect(canAccessDepartment(tl, DEPT_B)).toBe(false);
  });

  it("gives a member no department access even in their own department", () => {
    const member = context({ role: "member", primaryDepartmentId: DEPT_A });
    expect(canAccessDepartment(member, DEPT_A)).toBe(false);
  });

  it("denies a null department to everyone below owner", () => {
    // An unrouted form has department_id null. It must not become a hole that
    // every TL can walk through.
    const tl = context({ role: "team_leader", managedDepartmentIds: [DEPT_A] });
    expect(canAccessDepartment(tl, null)).toBe(false);
  });

  it("gives a manager exactly the departments they manage", () => {
    const manager = context({ role: "manager", managedDepartmentIds: [DEPT_A, DEPT_B] });
    expect(canAccessDepartment(manager, DEPT_A)).toBe(true);
    expect(canAccessDepartment(manager, DEPT_B)).toBe(true);
    expect(canAccessDepartment(manager, DEPT_C)).toBe(false);
  });
});

describe("departmentScopeFilter", () => {
  it("returns null for an owner — meaning no filter, see everything", () => {
    expect(departmentScopeFilter(context({ role: "owner" }))).toBeNull();
  });

  it("returns an EMPTY ARRAY for a member, which callers must read as zero rows", () => {
    // The dangerous confusion this pins down: `null` means "no filter" and `[]`
    // means "nothing". Treating [] as null turns a member into an owner.
    const filter = departmentScopeFilter(context({ role: "member" }));
    expect(filter).toEqual([]);
    expect(filter).not.toBeNull();
  });

  it("returns the managed set for a TL", () => {
    const tl = context({ role: "team_leader", managedDepartmentIds: [DEPT_A, DEPT_B] });
    expect(departmentScopeFilter(tl)).toEqual([DEPT_A, DEPT_B]);
  });

  it("returns an empty array for a TL who leads nothing, not null", () => {
    const tl = context({ role: "team_leader", managedDepartmentIds: [] });
    expect(departmentScopeFilter(tl)).toEqual([]);
  });
});

describe("departmentPickerScope", () => {
  /*
   * P7-66. The distinction `departmentScopeFilter` cannot express, and the one
   * that broke /forms/[id]: a picker query is BUILT, not filtered by a policy,
   * so "leads nothing" has to mean "do not run the query". Both call sites used
   * to narrow with `.in("id", [""])` instead, which always fails with
   * `invalid input syntax for type uuid: ""` — invisible while the error was
   * discarded, a hard page failure the moment it was not.
   */
  it("is `all` for an owner", () => {
    expect(departmentPickerScope(context({ role: "owner" }))).toEqual({ kind: "all" });
  });

  it("is `some` for a TL who leads departments", () => {
    const tl = context({ role: "team_leader", managedDepartmentIds: [DEPT_A, DEPT_B] });
    expect(departmentPickerScope(tl)).toEqual({ kind: "some", ids: [DEPT_A, DEPT_B] });
  });

  it("is `none` — never `some` with an empty list — for a TL who leads nothing", () => {
    const tl = context({ role: "team_leader", managedDepartmentIds: [] });
    const scope = departmentPickerScope(tl);

    expect(scope).toEqual({ kind: "none" });
    // The failure mode being pinned: anything that still carries ids reaches a
    // query, and an empty `in` list has no valid rendering.
    expect(scope.kind).not.toBe("some");
  });

  it("is `none` for a member, who routes nothing anywhere", () => {
    expect(departmentPickerScope(context({ role: "member" }))).toEqual({ kind: "none" });
  });
});

/**
 * P13-01 — THE COLLABORATION SPACE.
 *
 * ⚠️ THE POINT OF THESE CASES IS THE LINE, NOT THE WIDENING. A shared space is
 * a place to FILE WORK, and it is deliberately not a place anybody APPROVES
 * anything — so the two predicates that decide approval and visibility scope
 * (`canAccessDepartment`, `departmentScopeFilter`) must be untouched by it,
 * while the two that decide "may I shape this tree" and "may I file here" must
 * admit everybody. Half of the assertions below are that nothing moved.
 */
describe("the collaboration space", () => {
  const member = context({
    role: "member",
    primaryDepartmentId: DEPT_A,
    sharedDepartmentIds: [SHARED],
  });

  it("is recognised from the context, and only the ids that are in it", () => {
    expect(isCollaborationSpace(member, SHARED)).toBe(true);
    expect(isCollaborationSpace(member, DEPT_A)).toBe(false);
    expect(isCollaborationSpace(member, DEPT_B)).toBe(false);
  });

  it("is nothing at all before the migration is pasted", () => {
    // `sharedDepartmentIds` degrades to empty when the `is_shared` read fails,
    // which is the pre-migration truth. Nothing may turn that into a grant.
    const before = context({ role: "member", primaryDepartmentId: DEPT_A, sharedDepartmentIds: [] });

    expect(isCollaborationSpace(before, SHARED)).toBe(false);
    expect(canManageDepartmentTree(before, SHARED)).toBe(false);
  });

  it("⚠️ a null department is never the shared space", () => {
    // The same rule every other predicate in this module follows. A row with no
    // department is not "everyone's".
    expect(isCollaborationSpace(member, null)).toBe(false);
  });

  it("lets a plain member shape its tree", () => {
    // P11-07's rule, extended: a list is a shelf. This member leads nothing and
    // does not belong to this department — nobody does.
    expect(canManageDepartmentTree(member, SHARED)).toBe(true);
    // Still not another team's, which is the half that must not move.
    expect(canManageDepartmentTree(member, DEPT_B)).toBe(false);
  });

  it("gives somebody with no department a tree to manage", () => {
    const stray = context({ role: "member", primaryDepartmentId: null, sharedDepartmentIds: [SHARED] });

    expect(canManageAnyDepartmentTree(stray)).toBe(true);
    expect(canManageAnyDepartmentTree(context({ role: "member", primaryDepartmentId: null }))).toBe(
      false,
    );
  });

  it("appears in the tree picker for everybody, beside their own department", () => {
    expect(departmentTreeScope(member)).toEqual({ kind: "some", ids: [SHARED, DEPT_A] });
  });

  it("⚠️ is `some`, never `none`, for somebody who shapes nothing else", () => {
    // The sentinel trap `departmentPickerScope` was written for: "shapes
    // nothing" must never become a filter that matches nothing. Here they DO
    // shape something, so `none` would be wrong twice over.
    const stray = context({ role: "member", primaryDepartmentId: null, sharedDepartmentIds: [SHARED] });

    expect(departmentTreeScope(stray)).toEqual({ kind: "some", ids: [SHARED] });
  });

  it("does not turn an owner's `all` into a finite list", () => {
    const owner = context({ role: "owner", sharedDepartmentIds: [SHARED] });

    expect(departmentTreeScope(owner)).toEqual({ kind: "all" });
  });

  it("⚠️ confers NO approval or visibility scope", () => {
    // The load-bearing negative. Nobody leads a shared space and it holds no
    // queue; `canAccessDepartment` is what decides whose requests you review
    // and whose timesheet week you sign off.
    expect(canAccessDepartment(member, SHARED)).toBe(false);
    expect(departmentScopeFilter(member)).toEqual([]);
    expect(departmentPickerScope(member)).toEqual({ kind: "none" });
  });

  it("⚠️ does not make a team leader a lead of it", () => {
    const tl = context({
      role: "team_leader",
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_A],
      sharedDepartmentIds: [SHARED],
    });

    expect(canAccessDepartment(tl, SHARED)).toBe(false);
    expect(departmentScopeFilter(tl)).toEqual([DEPT_A]);
  });

  it("pushes realtime refreshes to everybody, so a shared board is not stale", () => {
    // Four teams typing into one list is the case this space exists for, and it
    // is the case where a page that does not repaint shows work already taken.
    expect(realtimeDepartmentScope(member)).toEqual([DEPT_A, SHARED]);
  });
});

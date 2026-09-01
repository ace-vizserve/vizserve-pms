import { describe, expect, it } from "vitest";

import {
  ROLE_ORDER,
  canAccessDepartment,
  departmentScopeFilter,
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
    primaryDepartmentId: null,
    managedDepartmentIds: [],
    ...overrides,
  };
}

describe("roleAtLeast — roles are inclusive (D15)", () => {
  it("mirrors the Postgres enum declaration order exactly", () => {
    // If these ever diverge, `role >= required` in SQL and `roleAtLeast` in TS
    // answer differently, and the difference shows up as a security bug rather
    // than a type error. Cheap assertion, expensive omission.
    expect(ROLE_ORDER).toEqual(["member", "team_leader", "manager", "admin"]);
  });

  it("admin satisfies every floor", () => {
    for (const required of ROLE_ORDER) {
      expect(roleAtLeast("admin", required)).toBe(true);
    }
  });

  it("member satisfies only the member floor", () => {
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("member", "team_leader")).toBe(false);
    expect(roleAtLeast("member", "manager")).toBe(false);
    expect(roleAtLeast("member", "admin")).toBe(false);
  });

  it("is >= and not ===, so an admin still reaches a team_leader gate", () => {
    // The real case this protects: Amier is an admin who is also a TL. An
    // equality check locks him out of his own approval queue.
    expect(roleAtLeast("admin", "team_leader")).toBe(true);
    expect(roleAtLeast("manager", "team_leader")).toBe(true);
  });

  it("treats a missing role as no authority rather than as a default", () => {
    expect(roleAtLeast(null, "member")).toBe(false);
    expect(roleAtLeast(undefined, "member")).toBe(false);
  });
});

describe("canAccessDepartment", () => {
  it("lets an admin reach every department, including ones they lead none of", () => {
    const admin = context({ role: "admin" });
    expect(canAccessDepartment(admin, DEPT_A)).toBe(true);
    expect(canAccessDepartment(admin, DEPT_C)).toBe(true);
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

  it("denies a null department to everyone below admin", () => {
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
  it("returns null for an admin — meaning no filter, see everything", () => {
    expect(departmentScopeFilter(context({ role: "admin" }))).toBeNull();
  });

  it("returns an EMPTY ARRAY for a member, which callers must read as zero rows", () => {
    // The dangerous confusion this pins down: `null` means "no filter" and `[]`
    // means "nothing". Treating [] as null turns a member into an admin.
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

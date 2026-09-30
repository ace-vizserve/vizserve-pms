import { describe, expect, it } from "vitest";

import {
  canAccessDepartment,
  canAdminDepartment,
  canDoHr,
  departmentScopeFilter,
  isSystemAdmin,
  ROLE_ORDER,
  roleAtLeast,
  type AuthContext,
  type Role,
} from "@/lib/auth/authorization";
import { ROLE_LABELS } from "@/lib/schemas/users";

/**
 * P8-01 — `owner` takes over what `admin` meant, and Admin becomes a TICK
 * scoped to the holder's own department.
 *
 * Written as the sibling of `tests/unit/hr-capability.test.ts`, which exists for
 * exactly this shape of change. Every regression this file is meant to catch is
 * one of two kinds:
 *
 *   1. somebody treats "department admin" as a RANK, and either a member with
 *      the tick never gets it or a manager without it silently does;
 *   2. somebody edits the ladder, and `indexOf` here stops agreeing with `>=`
 *      in Postgres — the disagreement `lib/auth/roles.ts` warns "shows up as a
 *      security bug rather than a type error".
 */

const DEPT_A = "d1000000-0000-4000-8000-00000000000a";
const DEPT_B = "d1000000-0000-4000-8000-00000000000b";

function context(overrides: Partial<AuthContext> & { role: Role }): AuthContext {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "test.someone@example.com",
    fullName: "Test Someone",
    gender: null,
    isHr: false,
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

describe("ROLE_ORDER — the ladder, with owner appended", () => {
  it("declares exactly the Postgres enum, in the enum's order", () => {
    // ⚠️ IF YOU ARE HERE BECAUSE THIS FAILED, DO NOT JUST UPDATE THE ARRAY.
    // This list must mirror `vizserve_pms_user_role`'s DECLARATION ORDER:
    //   ('member', 'team_leader', 'manager', 'admin', 'business_manager', 'owner')
    // — p0_02:22 plus p8_01a and p14_02a. `roleAtLeast` compares with indexOf and
    // `vizserve_pms_has_role` compares with `>=`, and the two must answer the
    // same question or a role check passes in the UI and fails in the database
    // (or, far worse, the reverse).
    expect([...ROLE_ORDER]).toEqual(["member", "team_leader", "manager", "admin", "business_manager", "owner"]);
  });

  it("keeps `admin` as a DEAD RUNG rather than deleting it", () => {
    // P8-01 promoted every admin to owner and the picker no longer offers it,
    // but the value is still declared in Postgres — dropping an enum value
    // means rebuilding the type on a live database. Removing it from here alone
    // would shift every index by one against a `>=` in SQL that did not move.
    expect(ROLE_ORDER).toContain("admin");
    expect(ROLE_ORDER.indexOf("admin")).toBe(ROLE_ORDER.indexOf("manager") + 1);
    expect(ROLE_ORDER.indexOf("business_manager")).toBe(ROLE_ORDER.indexOf("admin") + 1);
    expect(ROLE_ORDER.indexOf("owner")).toBe(ROLE_ORDER.indexOf("business_manager") + 1);
  });

  it("puts owner at the top, and nothing above it", () => {
    expect(ROLE_ORDER[ROLE_ORDER.length - 1]).toBe("owner");
  });
});

describe("roleAtLeast — still agrees with the enum order", () => {
  it("is inclusive upwards for every pair on the ladder", () => {
    // The property, not a handful of cases: `roleAtLeast(a, b)` must be true
    // exactly when a's position is at or above b's. This is the check that
    // catches a reordering rather than a rename.
    for (const [i, higher] of ROLE_ORDER.entries()) {
      for (const [j, lower] of ROLE_ORDER.entries()) {
        expect(roleAtLeast(higher, lower)).toBe(i >= j);
      }
    }
  });

  it("makes an owner satisfy every floor the old admin satisfied", () => {
    // Why nobody lost anything when `departmentScopeFilter` and
    // `canAccessDepartment` moved their floor up to `owner`: owner is above
    // admin, so every person who passed before still passes.
    for (const required of ROLE_ORDER) {
      if (required === "owner") continue;
      expect(roleAtLeast("owner", required)).toBe(true);
    }
  });

  it("refuses null and undefined rather than defaulting to member", () => {
    expect(roleAtLeast(null, "member")).toBe(false);
    expect(roleAtLeast(undefined, "member")).toBe(false);
  });
});

describe("P14-05 — Admin is IT: sees everything, configures, approves nothing", () => {
  const admin = context({ role: "admin" });

  it("reaches every department, like Business Manager and CEO", () => {
    for (const role of ["admin", "business_manager", "owner"] as const) {
      const viewer = context({ role });
      expect(canAccessDepartment(viewer, DEPT_A)).toBe(true);
      expect(canAccessDepartment(viewer, DEPT_B)).toBe(true);
      expect(departmentScopeFilter(viewer)).toBeNull();
    }
  });

  it("is the only role the configuration screens admit", () => {
    expect(isSystemAdmin(admin)).toBe(true);
    for (const role of ["member", "team_leader", "manager", "business_manager", "owner"] as const) {
      expect(isSystemAdmin(context({ role }))).toBe(false);
    }
  });

  it("sees the HR screens, as Manager and above do", () => {
    expect(canDoHr(admin)).toBe(true);
  });
});

describe("canAdminDepartment — Admin is a tick, not a rung (D33)", () => {
  it("grants it to an OWNER, for any department, without the flag", () => {
    // ⚠️ The load-bearing branch, and the one that would break production
    // silently. `vizserve_pms_is_dept_admin` has the same `u.role >= 'owner'`
    // clause; drop it on either side and ticking somebody as a department admin
    // would read as taking that department away from the owner.
    const owner = context({ role: "owner" });
    expect(canAdminDepartment(owner, DEPT_A)).toBe(true);
    expect(canAdminDepartment(owner, DEPT_B)).toBe(true);
  });

  it("grants it to a MEMBER with the tick, in their OWN department", () => {
    // The entire reason the column exists: a person who is a member by rank,
    // still reporting to their Team Leader, holding administrative capability
    // over the team they belong to.
    const deptAdmin = context({
      role: "member",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
    });
    expect(canAdminDepartment(deptAdmin, DEPT_A)).toBe(true);
  });

  it("REFUSES that same person in ANOTHER department", () => {
    // ⚠️ The scoping, and it is the whole point of the change. If this ever
    // returns true, "department admin" has quietly become "admin".
    const deptAdmin = context({
      role: "member",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
    });
    expect(canAdminDepartment(deptAdmin, DEPT_B)).toBe(false);
  });

  it("refuses a plain member, and a plain manager, in every department", () => {
    const member = context({ role: "member", primaryDepartmentId: DEPT_A });
    expect(canAdminDepartment(member, DEPT_A)).toBe(false);
    expect(canAdminDepartment(member, DEPT_B)).toBe(false);

    // Manager is the near miss — the rank most likely to be assumed into
    // administrative capability, and it is not one. If this had been added to
    // the enum instead of beside it, this is the case that would have flipped.
    const manager = context({ role: "manager", primaryDepartmentId: DEPT_A });
    expect(canAdminDepartment(manager, DEPT_A)).toBe(false);
    expect(canAdminDepartment(manager, DEPT_B)).toBe(false);
  });

  it("reads primary_department_id, NOT the managed set", () => {
    // A department admin administers the team they are IN, and does not lead
    // it. Reading the managed set here would turn the tick into a second,
    // invisible way of being a team leader.
    const ticked = context({
      role: "team_leader",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_B],
    });
    expect(canAdminDepartment(ticked, DEPT_A)).toBe(true);
    expect(canAdminDepartment(ticked, DEPT_B)).toBe(false);
  });

  it("is false on a null department for everyone but an owner", () => {
    // Mirrors the SQL, where `primary_department_id = null` is null and
    // therefore not true. "Administers no department" is the correct reading.
    expect(canAdminDepartment(context({ role: "owner" }), null)).toBe(true);
    expect(
      canAdminDepartment(context({ role: "member", isDeptAdmin: true }), null),
    ).toBe(false);
  });

  it("does not leak into approval authority", () => {
    // ⚠️ `vizserve_pms_manages_department` is deliberately untouched by P8-01,
    // and `canAccessDepartment` is its TypeScript half. A department admin
    // reports to their Team Leader; the tick confers NO approval rights. If
    // this ever passes, somebody has "fixed" the wrong predicate.
    const deptAdmin = context({
      role: "member",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
    });
    expect(canAccessDepartment(deptAdmin, DEPT_A)).toBe(false);
    expect(departmentScopeFilter(deptAdmin)).toEqual([]);
  });
});

describe("canDoHr — the HR tick, or Manager and above (P14-05)", () => {
  it("still grants it to the top rung without the flag", () => {
    // The P7-52 trap, restated for the rename. Section 1 of p8_01b promotes
    // every admin to owner; if `canDoHr` (or `vizserve_pms_is_hr`) had been
    // left reading "admin", every current admin would silently lose HR — no
    // error, zero rows.
    expect(canDoHr(context({ role: "owner", isHr: false }))).toBe(true);
  });

  it("still grants it to a MEMBER carrying the flag", () => {
    expect(canDoHr(context({ role: "member", isHr: true }))).toBe(true);
  });

  it("grants it to a manager without the flag, and refuses a team leader", () => {
    expect(canDoHr(context({ role: "manager", isHr: false }))).toBe(true);
    expect(canDoHr(context({ role: "team_leader", isHr: false }))).toBe(false);
  });

  it("is orthogonal to the department-admin tick in both directions", () => {
    // Two ticks, two jobs. Neither implies the other, and a change that made
    // one imply the other would be invisible until somebody read a leave
    // balance they should not have.
    const deptAdmin = context({
      role: "member",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
    });
    expect(canDoHr(deptAdmin)).toBe(false);

    const hr = context({ role: "member", isHr: true, primaryDepartmentId: DEPT_A });
    expect(canAdminDepartment(hr, DEPT_A)).toBe(false);
  });
});

describe("ROLE_LABELS", () => {
  it("labels every value in the enum, including the retired one", () => {
    // A `Record` over the whole union, so a legacy or restored `admin` row
    // still renders a name instead of a blank cell.
    for (const role of ROLE_ORDER) {
      expect(ROLE_LABELS[role].label).toBeTruthy();
    }
  });

  it("names Admin as IT and shows owner as CEO", () => {
    expect(ROLE_LABELS.admin.label).toMatch(/IT/);
    expect(ROLE_LABELS.owner.label).toBe("CEO");
  });
});

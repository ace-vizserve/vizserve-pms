import { describe, expect, it } from "vitest";

import { assignableInList, type AssignablePerson } from "@/lib/assignable";
import {
  canManageDepartmentTree,
  realtimeDepartmentScope,
  worksInDepartment,
  type AuthContext,
} from "@/lib/auth/rules";
import { departmentTreeScope } from "@/lib/auth/authorization";
import { belongsToDepartment, departmentsOf, withSubDepartments } from "@/lib/sub-departments";
import { normaliseSubDepartments } from "@/lib/schemas/users";

/**
 * P17-01 — A MAIN DEPARTMENT AND SUB DEPARTMENTS.
 *
 * Victoria moved from VizMedia to VizAssists and lost sight of every VizMedia
 * task. VizAssists is her MAIN department (approvals go there); VizMedia is a
 * SUB department — she still sees, edits and is assigned its tasks.
 *
 * These are the browser mirrors. `vizserve_pms_is_department_member` and the
 * policies in 20261016090000_p17_01_sub_departments.sql are the enforcement.
 */

const VIZASSISTS = "a1000000-0000-4000-8000-000000000002";
const VIZMEDIA = "a1000000-0000-4000-8000-000000000004";
const VIZBYTES = "a1000000-0000-4000-8000-000000000001";
const SHARED = "a1000000-0000-4000-8000-000000000005";

const ME = "00000000-0000-4000-8000-000000000001";

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ME,
    email: "test.someone@example.com",
    fullName: "Test Someone",
    gender: null,
    role: "member",
    isHr: false,
    isDeptAdmin: false,
    primaryDepartmentId: VIZASSISTS,
    managedDepartmentIds: [],
    sharedDepartmentIds: [],
    ...overrides,
  };
}

function person(
  id: string,
  full_name: string,
  primary_department_id: string | null,
  sub_department_ids: string[] = [],
): AssignablePerson {
  return { id, full_name, primary_department_id, sub_department_ids, is_active: true };
}

const VICTORIA = person("33333333-0000-4000-8000-000000000001", "Victoria Montesclaros", VIZASSISTS, [VIZMEDIA]);
const NERI = person("22222222-0000-4000-8000-000000000002", "Neri Lopez", VIZMEDIA);
const ASSISTS_COLLEAGUE = person("33333333-0000-4000-8000-000000000002", "Test Assists", VIZASSISTS);
const BYTES_COLLEAGUE = person("11111111-0000-4000-8000-000000000001", "Test Bytes", VIZBYTES);

describe("departmentsOf / belongsToDepartment", () => {
  it("lists the main department first, then the subs", () => {
    expect(departmentsOf(VICTORIA)).toEqual([VIZASSISTS, VIZMEDIA]);
  });

  it("counts a sub department as belonging", () => {
    expect(belongsToDepartment(VICTORIA, VIZMEDIA)).toBe(true);
    expect(belongsToDepartment(VICTORIA, VIZASSISTS)).toBe(true);
    expect(belongsToDepartment(VICTORIA, VIZBYTES)).toBe(false);
  });

  it("reads somebody with no sub field (before the migration) as main only", () => {
    expect(departmentsOf({ primary_department_id: VIZMEDIA })).toEqual([VIZMEDIA]);
    expect(departmentsOf({ primary_department_id: null })).toEqual([]);
  });

  it("does not repeat a sub that equals the main", () => {
    expect(departmentsOf({ primary_department_id: VIZMEDIA, sub_department_ids: [VIZMEDIA] })).toEqual([VIZMEDIA]);
  });

  it("never matches a null department", () => {
    expect(belongsToDepartment(VICTORIA, null)).toBe(false);
  });
});

describe("withSubDepartments", () => {
  it("attaches each person's rows, and an empty list to everybody else", () => {
    const merged = withSubDepartments(
      [{ id: VICTORIA.id }, { id: NERI.id }],
      [{ user_id: VICTORIA.id, department_id: VIZMEDIA }],
    );
    expect(merged).toEqual([
      { id: VICTORIA.id, sub_department_ids: [VIZMEDIA] },
      { id: NERI.id, sub_department_ids: [] },
    ]);
  });
});

describe("worksInDepartment — the viewer's task-side membership", () => {
  it("is true for the main and every sub department", () => {
    const victoria = context({ subDepartmentIds: [VIZMEDIA] });
    expect(worksInDepartment(victoria, VIZASSISTS)).toBe(true);
    expect(worksInDepartment(victoria, VIZMEDIA)).toBe(true);
    expect(worksInDepartment(victoria, VIZBYTES)).toBe(false);
  });

  it("is main only when the context carries no subs", () => {
    expect(worksInDepartment(context(), VIZMEDIA)).toBe(false);
  });
});

describe("the project tree and live updates include sub departments", () => {
  const victoria = context({ subDepartmentIds: [VIZMEDIA] });

  it("lets a sub member manage that department's lists", () => {
    expect(canManageDepartmentTree(victoria, VIZMEDIA)).toBe(true);
    expect(canManageDepartmentTree(victoria, VIZBYTES)).toBe(false);
  });

  it("offers the sub department in the tree picker", () => {
    const scope = departmentTreeScope(victoria);
    expect(scope.kind).toBe("some");
    if (scope.kind === "some") expect(scope.ids).toEqual(expect.arrayContaining([VIZASSISTS, VIZMEDIA]));
  });

  it("subscribes to the sub department's board", () => {
    expect(realtimeDepartmentScope(victoria)).toEqual([VIZASSISTS, VIZMEDIA]);
  });
});

describe("assignableInList — a sub member is in that department's lists", () => {
  const people = [VICTORIA, NERI, ASSISTS_COLLEAGUE, BYTES_COLLEAGUE];

  function call(overrides: Partial<Parameters<typeof assignableInList>[0]> = {}) {
    return assignableInList({
      people,
      collaborators: [],
      listDepartmentId: null,
      sharedDepartmentIds: [SHARED],
      role: "member",
      managedDepartmentIds: [],
      primaryDepartmentId: VIZMEDIA,
      selfId: NERI.id,
      ...overrides,
    }).map((p) => p.full_name);
  }

  it("offers Victoria in a VizMedia list, to a VizMedia member", () => {
    expect(call({ listDepartmentId: VIZMEDIA })).toEqual(["Victoria Montesclaros"]);
  });

  it("still offers her in her main department's lists", () => {
    expect(call({ listDepartmentId: VIZASSISTS, selfId: ME })).toEqual([
      "Victoria Montesclaros",
      "Test Assists",
    ]);
  });

  it("widens a sub member's own no-list scope to the sub department's people", () => {
    expect(
      call({ primaryDepartmentId: VIZASSISTS, subDepartmentIds: [VIZMEDIA], selfId: VICTORIA.id }),
    ).toEqual(["Neri Lopez", "Test Assists"]);
  });
});

describe("normaliseSubDepartments", () => {
  it("drops the main department and duplicates", () => {
    expect(normaliseSubDepartments(VIZASSISTS, [VIZMEDIA, VIZASSISTS, VIZMEDIA])).toEqual([VIZMEDIA]);
  });
});

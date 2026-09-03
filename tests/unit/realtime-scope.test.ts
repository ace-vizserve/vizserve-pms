import { describe, expect, it } from "vitest";

import {
  departmentScopeFilter,
  realtimeDepartmentFilter,
  realtimeDepartmentScope,
  type AuthContext,
  type Role,
} from "@/lib/auth/authorization";

/**
 * P8-03 — the pure half of the Realtime scope.
 *
 * ⚠️ THESE ASSERT FRESHNESS, NOT ACCESS, and the distinction is the point of the
 * feature. Nothing here is a security boundary: every event that survives the
 * filter these functions build is still authorized against the subscriber's own
 * JWT by the `vizserve_pms_tasks` SELECT policy. `tests/db/scope.test.ts` is
 * what proves the policy. What these prove is that the filter is never absent,
 * never empty and never accidentally company-wide — because a missing filter
 * does not fail closed, it fails OPEN into an unfiltered stream.
 *
 * No socket, no database. The functions under test are string arithmetic.
 */

const DEPT_A = "a1000000-0000-4000-8000-000000000001";
const DEPT_B = "a1000000-0000-4000-8000-000000000002";
const DEPT_C = "a1000000-0000-4000-8000-000000000003";

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
    ...overrides,
  };
}

describe("realtimeDepartmentScope — the union, deduped", () => {
  it("gives a plain member their own department", () => {
    // ⚠️ THE CASE `departmentScopeFilter` GETS RIGHT FOR ITS OWN PURPOSE AND
    // WRONG FOR THIS ONE. A member leads nothing, so the approval scope is
    // empty — but the SELECT policy's "same department and not personal" branch
    // means they DO see their team's tasks, and an empty set here would leave
    // the one group whose board never updates.
    const member = context({ role: "member", primaryDepartmentId: DEPT_A });

    expect(realtimeDepartmentScope(member)).toEqual([DEPT_A]);
    expect(departmentScopeFilter(member)).toEqual([]);
  });

  it("de-duplicates the usual case, where a lead leads the team they belong to", () => {
    const lead = context({
      role: "team_leader",
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_A],
    });

    // `in.(A,A)` would be legal and pointless. More to the point, a duplicate
    // would change the channel name for the same subscription.
    expect(realtimeDepartmentScope(lead)).toEqual([DEPT_A]);
  });

  it("unions the department they belong to with the ones they lead", () => {
    const lead = context({
      role: "team_leader",
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_B, DEPT_C],
    });

    // Own department first — that ordering is what makes a one-department
    // person get `eq.` instead of a one-element `in.()`.
    expect(realtimeDepartmentScope(lead)).toEqual([DEPT_A, DEPT_B, DEPT_C]);
  });

  it("covers a lead with no primary department of their own", () => {
    const lead = context({ role: "team_leader", managedDepartmentIds: [DEPT_B] });

    expect(realtimeDepartmentScope(lead)).toEqual([DEPT_B]);
  });

  it("⚠️ never widens an owner to the whole company", () => {
    // The deliberate gap, pinned so nobody "fixes" it into an unfiltered
    // stream. `departmentScopeFilter` answers `null` — "no filter" — for the
    // same person, and `null` reaching a subscription is the firehose.
    const owner = context({
      role: "owner",
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_B],
    });

    expect(realtimeDepartmentScope(owner)).toEqual([DEPT_A, DEPT_B]);
    expect(departmentScopeFilter(owner)).toBeNull();
  });

  it("returns nothing for somebody mapped to no department at all", () => {
    // A real state: a newly created account before anybody maps it.
    expect(realtimeDepartmentScope(context({ role: "member" }))).toEqual([]);
    expect(realtimeDepartmentScope(context({ role: "owner" }))).toEqual([]);
  });
});

describe("realtimeDepartmentFilter — the filter string", () => {
  it("uses eq for a single department", () => {
    const member = context({ role: "member", primaryDepartmentId: DEPT_A });

    expect(realtimeDepartmentFilter(member)).toBe(`department_id=eq.${DEPT_A}`);
  });

  it("uses in.() for several", () => {
    const lead = context({
      role: "manager",
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_B],
    });

    expect(realtimeDepartmentFilter(lead)).toBe(`department_id=in.(${DEPT_A},${DEPT_B})`);
  });

  it("⚠️ returns null — do not subscribe — rather than an empty filter", () => {
    // THE ONE ASSERTION THIS FILE EXISTS FOR. `department_id=in.()` would be
    // rejected or, worse, ignored, and an ignored filter clause is an
    // unfiltered stream of every task event in the company. There is no such
    // thing as a filter that matches nothing.
    const stranded = context({ role: "member" });

    expect(realtimeDepartmentFilter(stranded)).toBeNull();
  });

  it("never emits an empty parenthesis or a trailing comma for any role", () => {
    // A shape assertion rather than a value one: whatever the scope, the string
    // is either null or a well-formed single condition.
    for (const role of ["member", "team_leader", "manager", "admin", "owner"] as const) {
      for (const managed of [[], [DEPT_B], [DEPT_B, DEPT_C]]) {
        for (const primary of [null, DEPT_A]) {
          const filter = realtimeDepartmentFilter(
            context({ role, primaryDepartmentId: primary, managedDepartmentIds: managed }),
          );

          if (filter === null) continue;

          expect(filter).toMatch(
            /^department_id=(eq\.[0-9a-f-]+|in\.\([0-9a-f-]+(,[0-9a-f-]+)*\))$/,
          );
          expect(filter).not.toContain("()");
          expect(filter).not.toContain(",)");
        }
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  canAccessDepartment,
  canAdminDepartment,
  canShapeAnyDepartment,
  canShapeDepartment,
  departmentPickerScope,
  departmentScopeFilter,
  departmentShapeScope,
  type AuthContext,
  type Role,
} from "@/lib/auth/authorization";
import { NAV_ITEMS, visibleNavItems } from "@/lib/navigation";
import { administersForm } from "@/app/(app)/forms/administers";
import { updateUserSchema } from "@/lib/schemas/users";

/**
 * P8-01c — the three powers behind the department-admin tick, and the three
 * boundaries that are not oversights.
 *
 * `tests/unit/dept-admin-capability.test.ts` proves the tick EXISTS and is not a
 * rung. This file proves it REACHES something, and — the half that matters more
 * — proves it reaches nothing else. Every regression it is written to catch is
 * one of three kinds:
 *
 *   1. somebody widens `canAccessDepartment` or `departmentScopeFilter` to make
 *      a structure screen work, and hands every department admin an approval
 *      queue in the process. That is one edit away at all times, and it is the
 *      edit `20260903100100_p8_01b_admin_capability.sql` §7 forbids by name.
 *   2. somebody expresses "team leader OR department admin" as an AND — a nav
 *      row written `minRole: "member", requiresDeptAdmin: true` reads like the
 *      change and silently HIDES the row from every team leader.
 *   3. somebody makes the tick reach staff records or a company-wide screen.
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
    ...overrides,
  };
}

/** The person the whole change exists for: a MEMBER by rank, holding the tick. */
const memberAdmin = context({
  role: "member",
  isDeptAdmin: true,
  primaryDepartmentId: DEPT_A,
});

/** A lead of DEPT_A who does not hold the tick — the pre-P8-01c shape. */
const lead = context({
  role: "team_leader",
  primaryDepartmentId: DEPT_A,
  managedDepartmentIds: [DEPT_A],
});

const owner = context({ role: "owner" });

/** A member with neither, which every widening below must leave untouched. */
const plainMember = context({ role: "member", primaryDepartmentId: DEPT_A });

describe("canShapeDepartment — leading it OR holding the tick on it", () => {
  it("admits a MEMBER holding the tick, on their own department", () => {
    // The whole point. A rank floor cannot express this, which is why the
    // structure gates stopped being `requireRole("team_leader")`.
    expect(canShapeDepartment(memberAdmin, DEPT_A)).toBe(true);
  });

  it("refuses that same person on any other department", () => {
    // `vizserve_pms_is_dept_admin` compares against `primary_department_id`, a
    // single column, so there is exactly one department the tick can reach.
    expect(canShapeDepartment(memberAdmin, DEPT_B)).toBe(false);
  });

  it("still admits a lead who does not hold the tick", () => {
    // The additive half. P8-01c must widen and never transfer — the SQL side
    // adds policies BESIDE the lead policies for the same reason.
    expect(canShapeDepartment(lead, DEPT_A)).toBe(true);
  });

  it("admits an owner everywhere, including a null department", () => {
    expect(canShapeDepartment(owner, DEPT_A)).toBe(true);
    expect(canShapeDepartment(owner, DEPT_B)).toBe(true);
    expect(canShapeDepartment(owner, null)).toBe(true);
  });

  it("refuses a member with neither, on their own department", () => {
    expect(canShapeDepartment(plainMember, DEPT_A)).toBe(false);
  });

  it("is false on a null department for everybody but an owner", () => {
    // An unrouted form belongs to nobody's department, so the tick cannot
    // reach it — which is why `createForm` refuses a department-less form for
    // a tick-holder with a sentence rather than letting RLS answer.
    expect(canShapeDepartment(memberAdmin, null)).toBe(false);
    expect(canShapeDepartment(lead, null)).toBe(false);
  });

  it("is exactly the union of the two predicates it is built from", () => {
    // The property rather than a handful of cases: if somebody ever inlines a
    // third condition here, this fails.
    for (const who of [memberAdmin, lead, owner, plainMember]) {
      for (const dept of [DEPT_A, DEPT_B, null]) {
        expect(canShapeDepartment(who, dept)).toBe(
          canAccessDepartment(who, dept) || canAdminDepartment(who, dept),
        );
      }
    }
  });
});

describe("⛔ THE BOUNDARY — the tick still confers NO approval authority", () => {
  it("leaves `canAccessDepartment` refusing a department admin", () => {
    // ⚠️ IF THIS FAILS, SOMEBODY WIDENED THE WRONG PREDICATE. This is the
    // TypeScript half of `vizserve_pms_manages_department`, which decides who
    // may APPROVE — Gate 1, internal requests, timesheet weeks, leave. A
    // department admin reports to their Team Leader.
    expect(canAccessDepartment(memberAdmin, DEPT_A)).toBe(false);
  });

  it("leaves the list-query scope filter empty for a department admin", () => {
    // `departmentScopeFilter` is what /approvals and every lead-scoped list
    // narrow by. An empty array means zero rows, and it must stay empty:
    // widening it would put the tick-holder's team into queues the tick
    // confers no rights over.
    expect(departmentScopeFilter(memberAdmin)).toEqual([]);
    expect(departmentPickerScope(memberAdmin)).toEqual({ kind: "none" });
  });

  it("does not make the two predicates agree for anybody", () => {
    // Stated as a difference rather than two separate expectations, so a change
    // that quietly collapsed them into one function fails here.
    expect(canShapeDepartment(memberAdmin, DEPT_A)).not.toBe(
      canAccessDepartment(memberAdmin, DEPT_A),
    );
  });
});

describe("canShapeAnyDepartment — the page gate's question", () => {
  it("admits a member holding the tick", () => {
    expect(canShapeAnyDepartment(memberAdmin)).toBe(true);
  });

  it("admits a team leader who leads nothing YET", () => {
    // The pre-P8-01c behaviour of `requireRole("team_leader")`, and the state a
    // newly promoted lead is in before somebody maps them to a department.
    // Narrowing it would be this change taking something away.
    expect(canShapeAnyDepartment(context({ role: "team_leader" }))).toBe(true);
  });

  it("refuses a member with no tick", () => {
    expect(canShapeAnyDepartment(plainMember)).toBe(false);
  });

  it("refuses somebody carrying the flag with no department to apply it to", () => {
    // `is_dept_admin` with a null `primary_department_id` administers nothing —
    // a real state, since the auth trigger creates profile rows with no
    // department. It must not read as "administers everything".
    expect(
      canShapeAnyDepartment(context({ role: "member", isDeptAdmin: true })),
    ).toBe(false);
  });
});

describe("departmentShapeScope — the picker on the structure screens", () => {
  it("gives a member holding the tick their own department, not nothing", () => {
    // ⚠️ `departmentPickerScope` answers `none` for this person (proved above),
    // which is an empty department picker on a screen they can now open — a
    // form or list that cannot be saved for want of a department.
    expect(departmentShapeScope(memberAdmin)).toEqual({ kind: "some", ids: [DEPT_A] });
  });

  it("leaves an owner unfiltered rather than turning `all` into a list", () => {
    expect(departmentShapeScope(owner)).toEqual({ kind: "all" });
  });

  it("leaves a lead's managed set exactly as it was", () => {
    expect(departmentShapeScope(lead)).toEqual({ kind: "some", ids: [DEPT_A] });
  });

  it("does not list a department twice for a lead who also holds the tick", () => {
    // Otherwise the picker draws two identical options.
    const both = context({
      role: "team_leader",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_A],
    });
    expect(departmentShapeScope(both)).toEqual({ kind: "some", ids: [DEPT_A] });
  });

  it("adds the administered department beside the led ones", () => {
    const both = context({
      role: "team_leader",
      isDeptAdmin: true,
      primaryDepartmentId: DEPT_A,
      managedDepartmentIds: [DEPT_B],
    });
    expect(departmentShapeScope(both)).toEqual({ kind: "some", ids: [DEPT_B, DEPT_A] });
  });

  it("still answers `none` for somebody who shapes nothing", () => {
    // ⚠️ `none` MEANS DO NOT RUN THE QUERY. The sentinel it replaced,
    // `.in("id", [""])`, raises `invalid input syntax for type uuid: ""`.
    expect(departmentShapeScope(plainMember)).toEqual({ kind: "none" });
  });

  it("never narrows what `departmentPickerScope` already allowed", () => {
    // The property that makes this safe to swap in at a call site: it is a
    // widening in every case, never a transfer.
    for (const who of [memberAdmin, lead, owner, plainMember]) {
      const base = departmentPickerScope(who);
      const shape = departmentShapeScope(who);

      if (base.kind === "all") expect(shape.kind).toBe("all");
      if (base.kind === "some") {
        expect(shape.kind).toBe("some");
        if (shape.kind === "some") for (const id of base.ids) expect(shape.ids).toContain(id);
      }
    }
  });
});

describe("nav gating — `alsoDeptAdmin` is an OR, where `requiresDeptAdmin` is an AND", () => {
  const formsRow = NAV_ITEMS.find((item) => item.href === "/forms");

  it("marks Forms as reachable through the tick without lowering its floor", () => {
    // ⚠️ IF THIS FAILED BECAUSE SOMEBODY SET `minRole: "member",
    // requiresDeptAdmin: true`, DO NOT UPDATE THE ASSERTION. That pair reads
    // like the same change and hides Forms from every team leader who does not
    // hold the tick, which is most of them.
    expect(formsRow?.minRole).toBe("team_leader");
    expect(formsRow?.alsoDeptAdmin).toBe(true);
    expect(formsRow?.requiresDeptAdmin).toBeUndefined();
  });

  function hrefs(role: Role, isDeptAdmin: boolean) {
    return visibleNavItems(role, { isDeptAdmin }).map((item) => item.href);
  }

  it("shows Forms to a MEMBER holding the tick", () => {
    expect(hrefs("member", true)).toContain("/forms");
  });

  it("still shows Forms to a team leader WITHOUT the tick", () => {
    expect(hrefs("team_leader", false)).toContain("/forms");
  });

  it("still hides Forms from a member with neither", () => {
    expect(hrefs("member", false)).not.toContain("/forms");
  });

  it("does not let the tick open anything else in the rail", () => {
    // ⛔ THE BOUNDARY, as the sidebar sees it. A member holding the tick gets
    // exactly one row more than a member without it, and it is Forms.
    const withTick = hrefs("member", true);
    const without = hrefs("member", false);
    expect(withTick.filter((href) => !without.includes(href))).toEqual(["/forms"]);
  });

  it("keeps every company-wide admin screen out of reach of the tick", () => {
    // ⛔ NOTHING COMPANY-WIDE — not settings, not the holiday calendar, not the
    // unfiltered audit trail, and above all not staff records, which is what
    // stops the tick escalating itself.
    const withTick = hrefs("member", true);
    for (const href of ["/admin/users", "/admin/settings", "/admin/audit", "/admin/events"]) {
      expect(withTick).not.toContain(href);
    }
  });

  it("does not grant HR by carrying the other tick", () => {
    // The two capabilities are ANDed with their own flags and neither implies
    // the other. Passing `isDeptAdmin` alone must not open the HR group.
    expect(hrefs("member", true)).not.toContain("/hr/balances");
  });
});

describe("administersForm — the builder's scope, widened by the tick", () => {
  const clientForm = { department_id: DEPT_A, created_by: null, purpose: "CLIENT_REQUEST" };

  it("admits a member holding the tick on their own department's client form", () => {
    expect(administersForm(memberAdmin, clientForm)).toBe(true);
  });

  it("refuses them another department's client form", () => {
    expect(administersForm(memberAdmin, { ...clientForm, department_id: DEPT_B })).toBe(false);
  });

  it("⛔ still refuses them an INTERNAL form, on their OWN department", () => {
    // ⚠️ THE BOUNDARY THAT IS EASIEST TO LOSE. An internal form is a
    // company-wide instrument — it reads the whole staff roster and its audience
    // can be everybody — so P7-66 Phase 5 made it owner-only on five policies at
    // once. A tick scoped to one department has no business creating one, and
    // `p8_01c` carries `purpose <> 'INTERNAL'` on every forms policy it adds.
    expect(administersForm(memberAdmin, { ...clientForm, purpose: "INTERNAL" })).toBe(false);
  });

  it("still refuses a plain member the same form", () => {
    expect(administersForm(plainMember, clientForm)).toBe(false);
  });

  it("still admits a lead, and still refuses one on another department", () => {
    expect(administersForm(lead, clientForm)).toBe(true);
    expect(administersForm(lead, { ...clientForm, department_id: DEPT_B })).toBe(false);
  });

  it("does not hand the tick an unrouted draft it did not create", () => {
    // A department-less form is nobody's department, and the tick is defined by
    // one. The author carve-out is the only way in, and it is not theirs.
    expect(
      administersForm(memberAdmin, {
        department_id: null,
        created_by: "00000000-0000-4000-8000-0000000000ff",
        purpose: "CLIENT_REQUEST",
      }),
    ).toBe(false);
  });

  it("still gives a team leader their own unrouted draft", () => {
    // The carve-out that existed before P8-01c, unchanged — the new floor must
    // widen it, not replace it.
    expect(
      administersForm(lead, {
        department_id: null,
        created_by: lead.userId,
        purpose: "CLIENT_REQUEST",
      }),
    ).toBe(true);
  });
});

/**
 * P8-01c follow-up — a tick that would grant nothing must not save.
 *
 * `vizserve_pms_is_dept_admin(p_department_id)` compares its argument with the
 * holder's `primary_department_id`, and `canAdminDepartment` returns false the
 * moment either side is null. So the combination below is not merely useless:
 * it leaves a switch on screen claiming a capability nobody has, set by an
 * owner with no way to notice.
 */
describe("the admin tick needs a department to be scoped to", () => {
  const base = {
    full_name: "Jane Cruz",
    gender: "FEMALE" as const,
    role: "member" as const,
    is_hr: false,
    managed_department_ids: [],
    is_active: true,
    app_access: true,
    work_start: null,
    work_end: null,
    break_minutes: "",
  };

  it("refuses the tick when no primary department is set", () => {
    const result = updateUserSchema.safeParse({
      ...base,
      is_dept_admin: true,
      primary_department_id: null,
    });

    expect(result.success).toBe(false);
    // The message has to name the fix, not the rule — an owner reading it is
    // one field away from a valid record.
    expect(JSON.stringify(result.error?.issues)).toContain("department this person belongs to");
  });

  it("accepts the tick once a department is chosen", () => {
    expect(
      updateUserSchema.safeParse({
        ...base,
        is_dept_admin: true,
        primary_department_id: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      }).success,
    ).toBe(true);
  });

  it("leaves an untricked record with no department alone", () => {
    // The rule is about the TICK, not about departments — plenty of people
    // legitimately have neither.
    expect(
      updateUserSchema.safeParse({
        ...base,
        is_dept_admin: false,
        primary_department_id: null,
      }).success,
    ).toBe(true);
  });
});

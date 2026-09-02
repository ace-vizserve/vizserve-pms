import { describe, expect, it } from "vitest";

import { canDoHr, type AuthContext, type Role } from "@/lib/auth/authorization";
import { groupedNavItems, visibleNavItems } from "@/lib/navigation";
import { leaveReportFilterSchema } from "@/lib/schemas/leave-report";

/**
 * P7-52 / P7-53 — the HR capability.
 *
 * The thing worth pinning here is that HR is ORTHOGONAL to the role ladder.
 * Every regression this file is meant to catch has the same shape: somebody
 * treats HR as a rank, and either an admin quietly loses a screen or a member
 * with the flag never gets one.
 */

const UUID_A = "b1000000-0000-4000-8000-000000000001";
const UUID_B = "b1000000-0000-4000-8000-000000000002";

function context(overrides: Partial<AuthContext> & { role: Role }): AuthContext {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "test.someone@example.com",
    fullName: "Test Someone",
    gender: null,
    isHr: false,
    // P8-01. The department-admin tick — orthogonal to `role`, exactly as
    // `isHr` is, and false unless a test says otherwise.
    isDeptAdmin: false,
    primaryDepartmentId: null,
    managedDepartmentIds: [],
    ...overrides,
  };
}

describe("canDoHr — HR is a job, not a rank (D33)", () => {
  it("grants the capability to a MEMBER carrying the flag", () => {
    // The entire reason the column exists. If this fails, HR is back to needing
    // an admin account to do their own job.
    expect(canDoHr(context({ role: "member", isHr: true }))).toBe(true);
  });

  it("grants it to an OWNER who does NOT carry the flag", () => {
    // ⚠️ The one that would break production silently. The top rung IS HR —
    // `vizserve_pms_leave_balances` says so at p7_33:262 — so P7-52 widened
    // every one of those checks from is_admin() to is_hr(). If this reading
    // dropped the owner branch, granting HR to somebody would REVOKE it from
    // every owner, and the SQL and the UI would then disagree about who can
    // open a screen.
    //
    // P8-01 renamed the rung this asks about (`admin` -> `owner`) on both sides
    // at once. Renaming it in only one place is EXACTLY the failure above.
    expect(canDoHr(context({ role: "owner", isHr: false }))).toBe(true);
    // And the dead rung grants nothing any more. Nobody holds it, but a row
    // restored from a backup might, and it must not inherit HR.
    expect(canDoHr(context({ role: "admin", isHr: false }))).toBe(false);
  });

  it("refuses a plain member and a plain team leader", () => {
    expect(canDoHr(context({ role: "member" }))).toBe(false);
    expect(canDoHr(context({ role: "team_leader" }))).toBe(false);
  });

  it("refuses a MANAGER, which is the near miss", () => {
    // Manager is the rank most likely to be assumed into HR, and it is not: a
    // manager runs departments, HR runs entitlement. If HR had been added to
    // the enum instead of beside it, this is the case that would have silently
    // flipped.
    expect(canDoHr(context({ role: "manager", isHr: false }))).toBe(false);
    expect(canDoHr(context({ role: "manager", isHr: true }))).toBe(true);
  });
});

describe("nav gating — role and capability are ANDed, never substituted", () => {
  const hrHrefs = ["/hr/balances", "/hr/leave-types", "/hr/reports", "/hr/attendance"];

  it("hides every /hr route from a member without the flag", () => {
    const hrefs = visibleNavItems("member", { isHr: false }).map((item) => item.href);
    for (const href of hrHrefs) expect(hrefs).not.toContain(href);
  });

  it("shows every /hr route to a MEMBER with the flag", () => {
    const hrefs = visibleNavItems("member", { isHr: true }).map((item) => item.href);
    for (const href of hrHrefs) expect(hrefs).toContain(href);
  });

  it("does NOT give an HR member any /admin route", () => {
    // HR cannot appoint HR — that is what stops the capability escalating
    // itself, and the nav has to agree with the gate on /admin/users.
    const hrefs = visibleNavItems("member", { isHr: true }).map((item) => item.href);
    expect(hrefs).not.toContain("/admin/users");
    expect(hrefs).not.toContain("/admin/audit");
    expect(hrefs).not.toContain("/admin/settings");
  });

  it("omits the /hr rows when no viewer is passed at all", () => {
    // The default is deny. A caller that forgets to pass the viewer gets a nav
    // with no HR in it, which is a visible bug; the alternative default would
    // show HR screens to everybody, which is a silent one.
    const hrefs = visibleNavItems("owner").map((item) => item.href);
    for (const href of hrHrefs) expect(hrefs).not.toContain(href);
  });

  it("renders an HR group for an HR member and no Admin group", () => {
    const sections = groupedNavItems("member", { isHr: true });
    const labels = sections.map((section) => section.group.label);

    expect(labels).toContain("HR");
    expect(labels).not.toContain("Admin");
  });

  it("renders both groups for an owner, HR before Admin", () => {
    const labels = groupedNavItems("owner", { isHr: true }).map((s) => s.group.label);

    expect(labels).toContain("HR");
    expect(labels).toContain("Admin");
    expect(labels.indexOf("HR")).toBeLessThan(labels.indexOf("Admin"));
  });

  it("drops the HR group entirely rather than rendering it empty", () => {
    const labels = groupedNavItems("owner", { isHr: false }).map((s) => s.group.label);
    expect(labels).not.toContain("HR");
  });
});

describe("leaveReportFilterSchema — the two modes are unspellable as each other", () => {
  it("accepts an unfiltered annual report", () => {
    const result = leaveReportFilterSchema.safeParse({ mode: "annual", year: 2026 });
    expect(result.success).toBe(true);
  });

  it("accepts a taken report with a range", () => {
    const result = leaveReportFilterSchema.safeParse({
      mode: "taken",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(result.success).toBe(true);
  });

  it("REFUSES an empty filter array", () => {
    // ⚠️ The one that matters. Both SQL functions read a null array as
    // "everything in scope", so `[]` does not mean "no filter" — it means
    // "match nothing", and would produce a PDF with a header, a footer and no
    // rows. On an audit document that is indistinguishable from a broken
    // export, and somebody would go hunting for the bug in the wrong place.
    const result = leaveReportFilterSchema.safeParse({
      mode: "annual",
      year: 2026,
      userIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("treats an ABSENT filter as no filter", () => {
    const result = leaveReportFilterSchema.safeParse({
      mode: "annual",
      year: 2026,
      departmentIds: [UUID_A, UUID_B],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.departmentIds).toEqual([UUID_A, UUID_B]);
      // undefined, not [] — the action turns this into a SQL null.
      expect(result.data.userIds).toBeUndefined();
    }
  });

  it("refuses a backwards range with the message on the end date", () => {
    const result = leaveReportFilterSchema.safeParse({
      mode: "taken",
      from: "2026-03-31",
      to: "2026-03-01",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("to"))).toBe(true);
    }
  });

  it("accepts a single-day range", () => {
    const result = leaveReportFilterSchema.safeParse({
      mode: "taken",
      from: "2026-03-02",
      to: "2026-03-02",
    });
    expect(result.success).toBe(true);
  });

  it("refuses a year on the taken mode and a range on the annual mode", () => {
    // The union is what makes "annual with a from-date" unrepresentable rather
    // than merely discouraged.
    expect(
      leaveReportFilterSchema.safeParse({ mode: "taken", year: 2026 }).success,
    ).toBe(false);
    expect(
      leaveReportFilterSchema.safeParse({ mode: "annual", from: "2026-01-01", to: "2026-12-31" })
        .success,
    ).toBe(false);
  });

  it("refuses an impossible date", () => {
    // Inherited from `holidayDateSchema`, which rebuilds and compares rather
    // than merely parsing — `Date` rolls 31 February forward into March.
    expect(
      leaveReportFilterSchema.safeParse({ mode: "taken", from: "2026-02-31", to: "2026-03-01" })
        .success,
    ).toBe(false);
  });
});

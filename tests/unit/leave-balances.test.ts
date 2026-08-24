import { describe, expect, it } from "vitest";

import {
  allocatedDaysSchema,
  balanceYearSchema,
  currentBalanceYear,
  formatDays,
  setLeaveAllocationsSchema,
} from "@/lib/schemas/leave-balances";

/**
 * P7-33 — the leave-allocation contract.
 *
 * THIS FILE REPLACES tests/unit/no-leave-balance.test.ts, which failed the build
 * if the identifier `leave_balance` appeared anywhere. That guard did its job:
 * balances stayed out of scope through P7-12 and P7-16, both of which recorded
 * being tempted. It was deleted deliberately when Amier asked for per-type
 * balances on 24 Aug 2026 — see D27 — because the test itself said deletion
 * should be an explicit act rather than a column that quietly appeared.
 *
 * What is worth pinning now is different. The arithmetic lives in SQL, where
 * `vizserve_pms_leave_balance_summary` computes usage from approved requests, so
 * there is nothing here to unit test about it — and a TypeScript copy would be
 * exactly the second opinion the design exists to avoid. What lives in TS is the
 * VALIDATION an admin's typing has to survive, and one wrong figure there is
 * written straight into somebody's entitlement.
 */

const TYPE_A = "11111111-1111-4111-8111-111111111111";
const TYPE_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

describe("allocatedDaysSchema", () => {
  it("accepts whole and half days", () => {
    // Half days because P7-16 lets leave start or end at midday, so an
    // allocation of 12.5 is a figure a request can actually land on.
    expect(allocatedDaysSchema.parse("12")).toBe(12);
    expect(allocatedDaysSchema.parse("12.5")).toBe(12.5);
    expect(allocatedDaysSchema.parse("0.5")).toBe(0.5);
  });

  it("accepts zero, which is a real statement", () => {
    // "You get no vacation leave this year" is a decision somebody made, and it
    // has to be distinguishable from nobody having decided. The editor sends a
    // typed 0; a blank box is filtered out before it ever reaches this schema.
    expect(allocatedDaysSchema.parse("0")).toBe(0);
  });

  it("refuses a third of a day", () => {
    // Nothing can consume 12.3 days, so accepting it would store a number that
    // no sequence of requests could ever draw down exactly.
    expect(allocatedDaysSchema.safeParse("12.3").success).toBe(false);
    expect(allocatedDaysSchema.safeParse("0.25").success).toBe(false);
  });

  it("refuses negatives and more days than a year holds", () => {
    expect(allocatedDaysSchema.safeParse("-1").success).toBe(false);
    expect(allocatedDaysSchema.safeParse("400").success).toBe(false);
  });

  it("refuses a blank rather than reading it as zero", () => {
    // The trap this exists for: `Number("")` is 0, so a coercion without a guard
    // would silently write "no leave" over an allocation an admin only cleared
    // by accident. The editor filters blanks out too; this is the second wall.
    expect(allocatedDaysSchema.safeParse("").success).toBe(false);
    expect(allocatedDaysSchema.safeParse("   ").success).toBe(false);
    expect(allocatedDaysSchema.safeParse("ten").success).toBe(false);
  });
});

describe("balanceYearSchema", () => {
  it("accepts a plausible year", () => {
    expect(balanceYearSchema.parse("2026")).toBe(2026);
  });

  it("refuses a mistyped one", () => {
    // Bounded 2020–2100, matching the CHECK constraint. An allocation outside
    // that is not wrong so much as unreachable: no request will ever be
    // measured against it, and the symptom is "the number I set did not save".
    expect(balanceYearSchema.safeParse("1999").success).toBe(false);
    expect(balanceYearSchema.safeParse("22026").success).toBe(false);
    expect(balanceYearSchema.safeParse("26").success).toBe(false);
    expect(balanceYearSchema.safeParse("2026.5").success).toBe(false);
  });
});

describe("setLeaveAllocationsSchema", () => {
  it("takes the whole set for one person and one year", () => {
    const parsed = setLeaveAllocationsSchema.parse({
      user_id: USER,
      balance_year: "2026",
      allocations: [
        { leave_type_id: TYPE_A, days_allocated: "10" },
        { leave_type_id: TYPE_B, days_allocated: "5.5" },
      ],
    });

    expect(parsed.balance_year).toBe(2026);
    expect(parsed.allocations).toEqual([
      { leave_type_id: TYPE_A, days_allocated: 10 },
      { leave_type_id: TYPE_B, days_allocated: 5.5 },
    ]);
  });

  it("accepts an empty set", () => {
    // An admin who has typed nothing has said nothing. The action skips the
    // upsert entirely rather than treating it as "zero everything".
    expect(
      setLeaveAllocationsSchema.parse({
        user_id: USER,
        balance_year: 2026,
        allocations: [],
      }).allocations,
    ).toEqual([]);
  });

  it("rejects the whole save when one figure is wrong", () => {
    // All-or-nothing on purpose: writing the good rows and dropping the bad one
    // would leave an admin looking at a screen that saved, with one allowance
    // silently unchanged.
    const result = setLeaveAllocationsSchema.safeParse({
      user_id: USER,
      balance_year: 2026,
      allocations: [
        { leave_type_id: TYPE_A, days_allocated: "10" },
        { leave_type_id: TYPE_B, days_allocated: "-3" },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("formatDays", () => {
  it("says day or days", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(2)).toBe("2 days");
    expect(formatDays(0)).toBe("0 days");
  });

  it("keeps a half but drops a trailing zero", () => {
    // "12.0 days" on every line makes an allocation list look like a
    // spreadsheet export; "12 days" is what somebody would say out loud.
    expect(formatDays(12.5)).toBe("12.5 days");
    expect(formatDays(12)).toBe("12 days");
  });

  it("pluralises an overdraw by its magnitude", () => {
    // The dialog renders `formatDays(-remaining)`, so this only ever sees a
    // positive number — but a stray negative must not read "-1 days".
    expect(formatDays(-1)).toBe("-1 day");
  });
});

describe("currentBalanceYear", () => {
  it("reads the year off an app-zone date", () => {
    // Manila's year, not the server's. On 1 January a UTC server is still in
    // December for eight hours, and defaulting to the wrong year would show
    // everybody last year's allocation against this year's first request.
    expect(currentBalanceYear("2026-01-01")).toBe(2026);
    expect(currentBalanceYear("2026-12-31")).toBe(2026);
  });
});

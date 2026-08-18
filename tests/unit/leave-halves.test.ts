import { describe, expect, it } from "vitest";

import {
  describeLeaveSpan,
  internalRequestSchema,
} from "@/lib/schemas/internal-requests";

/**
 * P7-16 — half-day leave.
 *
 * The single-day rule is the part worth testing without a database: it is the
 * one a person can trip over, and it is enforced three times — here in zod, as a
 * CHECK constraint, and as a sentence inside
 * `vizserve_pms_submit_internal_request` — so the three have to agree about what
 * is legal. The db suite covers the other two.
 */
const base = {
  request_type: "LEAVE" as const,
  reason: "Family matters to attend to.",
  leave_type_id: "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
};

describe("leave halves", () => {
  it("defaults to a whole span, which is what every request meant before", () => {
    const parsed = internalRequestSchema.parse({
      ...base,
      start_date: "2026-09-03",
      end_date: "2026-09-05",
    });

    expect(parsed).toMatchObject({ start_half: "MORNING", end_half: "AFTERNOON" });
  });

  it("accepts half a day at either end of a multi-day span", () => {
    // Afternoon-to-morning across two days is the ordinary shape: away after
    // lunch on Thursday, back after lunch on Friday.
    expect(() =>
      internalRequestSchema.parse({
        ...base,
        start_date: "2026-09-03",
        end_date: "2026-09-04",
        start_half: "AFTERNOON",
        end_half: "MORNING",
      }),
    ).not.toThrow();
  });

  it("accepts a single morning and a single afternoon", () => {
    for (const half of ["MORNING", "AFTERNOON"] as const) {
      expect(() =>
        internalRequestSchema.parse({
          ...base,
          start_date: "2026-09-03",
          end_date: "2026-09-03",
          start_half: half,
          end_half: half,
        }),
      ).not.toThrow();
    }
  });

  it("refuses afternoon-to-morning on ONE day", () => {
    // Legal across two days, meaningless within one — the span would run
    // backwards inside the day.
    expect(() =>
      internalRequestSchema.parse({
        ...base,
        start_date: "2026-09-03",
        end_date: "2026-09-03",
        start_half: "AFTERNOON",
        end_half: "MORNING",
      }),
    ).toThrow(/afternoon and end in the morning/i);
  });

  it("keeps halves off every other request type", () => {
    // Structural rather than a validation: the discriminated union means a
    // reimbursement has no half to send in the first place.
    const reimbursement = internalRequestSchema.parse({
      request_type: "REIMBURSEMENT",
      reason: "Taxi to the client site.",
      amount: 450,
    });

    expect(reimbursement).not.toHaveProperty("start_half");
  });
});

describe("describeLeaveSpan", () => {
  /** Day-of-month only, so the assertions read as shapes rather than dates. */
  const day = (value: string) => value.slice(8);

  it("says nothing about halves on a whole span", () => {
    // "(morning)" on the first day of every full-day request adds a word to
    // every row and distinguishes nothing.
    expect(describeLeaveSpan("2026-09-03", "2026-09-05", "MORNING", "AFTERNOON", day)).toBe(
      "03 – 05",
    );
  });

  it("marks a partial start and a partial end", () => {
    expect(describeLeaveSpan("2026-09-03", "2026-09-05", "AFTERNOON", "MORNING", day)).toBe(
      "03 (afternoon) – 05 (morning)",
    );
  });

  it("collapses a single day rather than ranging it against itself", () => {
    expect(describeLeaveSpan("2026-09-03", "2026-09-03", "MORNING", "AFTERNOON", day)).toBe("03");
    expect(describeLeaveSpan("2026-09-03", "2026-09-03", "MORNING", "MORNING", day)).toBe(
      "03 (morning only)",
    );
    expect(describeLeaveSpan("2026-09-03", "2026-09-03", "AFTERNOON", "AFTERNOON", day)).toBe(
      "03 (afternoon only)",
    );
  });

  it("reads the rows written before P7-16 as whole spans", () => {
    // Null on both halves is every leave request filed before this shipped, and
    // a whole span is exactly what those meant.
    expect(describeLeaveSpan("2026-09-03", "2026-09-05", null, null, day)).toBe("03 – 05");
  });
});

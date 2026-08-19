import { describe, expect, it } from "vitest";

import {
  describeLeaveDay,
  expandLeaveDays,
  leaveKey,
  type LeaveSpan,
} from "@/lib/leave";

/**
 * Approved leave, expanded into the days the DTR has to show.
 *
 * The arithmetic these tests pin down is what stops a payroll file overstating
 * an absence. Before this existed, a day off had no `dtr_entries` row and so no
 * line in the CSV at all — an approved holiday and an unexcused no-show looked
 * identical to whoever ran payroll. Getting the HALVES wrong would be the same
 * failure one size smaller: a half day exported as a whole one.
 *
 * The rules under test come straight off the column comments in P7-16:
 *
 *   start_half  MORNING   = the whole of that day
 *               AFTERNOON = from midday
 *   end_half    AFTERNOON = the whole of that day
 *               MORNING   = until midday
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

function span(overrides: Partial<LeaveSpan> = {}): LeaveSpan {
  return {
    user_id: ALICE,
    start_date: "2026-08-10",
    end_date: "2026-08-10",
    start_half: "MORNING",
    end_half: "AFTERNOON",
    type_name: "Vacation leave",
    ...overrides,
  };
}

describe("expandLeaveDays — which days a span covers", () => {
  it("covers a single whole day", () => {
    const days = expandLeaveDays([span()], "2026-08-01", "2026-08-31");

    expect(days.size).toBe(1);
    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("full");
  });

  it("covers every day of a multi-day span, ends included", () => {
    const days = expandLeaveDays(
      [span({ start_date: "2026-08-10", end_date: "2026-08-13" })],
      "2026-08-01",
      "2026-08-31",
    );

    expect([...days.keys()].sort()).toEqual([
      leaveKey(ALICE, "2026-08-10"),
      leaveKey(ALICE, "2026-08-11"),
      leaveKey(ALICE, "2026-08-12"),
      leaveKey(ALICE, "2026-08-13"),
    ]);
  });

  it("keeps two people's leave apart", () => {
    const days = expandLeaveDays([span(), span({ user_id: BOB })], "2026-08-01", "2026-08-31");

    expect(days.size).toBe(2);
    expect(days.has(leaveKey(ALICE, "2026-08-10"))).toBe(true);
    expect(days.has(leaveKey(BOB, "2026-08-10"))).toBe(true);
  });
});

describe("expandLeaveDays — halves", () => {
  it("reads a morning-only single day", () => {
    const days = expandLeaveDays(
      [span({ start_half: "MORNING", end_half: "MORNING" })],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("morning");
  });

  it("reads an afternoon-only single day", () => {
    const days = expandLeaveDays(
      [span({ start_half: "AFTERNOON", end_half: "AFTERNOON" })],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("afternoon");
  });

  it("starts from midday and still ends whole", () => {
    const days = expandLeaveDays(
      [
        span({
          start_date: "2026-08-10",
          end_date: "2026-08-12",
          start_half: "AFTERNOON",
          end_half: "AFTERNOON",
        }),
      ],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("afternoon");
    expect(days.get(leaveKey(ALICE, "2026-08-11"))?.portion).toBe("full");
    expect(days.get(leaveKey(ALICE, "2026-08-12"))?.portion).toBe("full");
  });

  it("ends at midday and still starts whole", () => {
    const days = expandLeaveDays(
      [
        span({
          start_date: "2026-08-10",
          end_date: "2026-08-12",
          start_half: "MORNING",
          end_half: "MORNING",
        }),
      ],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("full");
    expect(days.get(leaveKey(ALICE, "2026-08-11"))?.portion).toBe("full");
    expect(days.get(leaveKey(ALICE, "2026-08-12"))?.portion).toBe("morning");
  });

  it("takes half off each end, which is the ordinary shape", () => {
    const days = expandLeaveDays(
      [
        span({
          start_date: "2026-08-10",
          end_date: "2026-08-12",
          start_half: "AFTERNOON",
          end_half: "MORNING",
        }),
      ],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("afternoon");
    expect(days.get(leaveKey(ALICE, "2026-08-11"))?.portion).toBe("full");
    expect(days.get(leaveKey(ALICE, "2026-08-12"))?.portion).toBe("morning");
  });

  it("treats a row that predates P7-16 as a whole day", () => {
    // Existing leave rows have NULL halves and there is no honest way to
    // backfill them. Reading null as a whole day matches how those requests
    // were actually filed, and is the only reading that cannot understate.
    const days = expandLeaveDays(
      [span({ start_half: null, end_half: null })],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.get(leaveKey(ALICE, "2026-08-10"))?.portion).toBe("full");
  });

  it("adds two halves of the same day into a whole one", () => {
    // Two separate requests, each approved, that between them cover the day.
    // Taking either one alone would report a half day off for a day the person
    // was not there at all.
    const days = expandLeaveDays(
      [
        span({ start_half: "MORNING", end_half: "MORNING", type_name: "Sick leave" }),
        span({ start_half: "AFTERNOON", end_half: "AFTERNOON", type_name: "Vacation leave" }),
      ],
      "2026-08-01",
      "2026-08-31",
    );

    const day = days.get(leaveKey(ALICE, "2026-08-10"));
    expect(day?.portion).toBe("full");
    expect(day?.typeNames).toEqual(["Sick leave", "Vacation leave"]);
  });
});

describe("expandLeaveDays — the range", () => {
  it("clamps a span that runs past both ends", () => {
    // Leave running 28 Aug – 3 Sep is relevant to a September payroll run for
    // its first three days. The query selects on overlap for this reason and
    // the expansion has to honour it rather than emitting August dates into a
    // September file.
    const days = expandLeaveDays(
      [span({ start_date: "2026-08-28", end_date: "2026-09-03" })],
      "2026-09-01",
      "2026-09-30",
    );

    expect([...days.keys()].sort()).toEqual([
      leaveKey(ALICE, "2026-09-01"),
      leaveKey(ALICE, "2026-09-02"),
      leaveKey(ALICE, "2026-09-03"),
    ]);
  });

  it("carries the end halves only onto the real end dates, not the clamped ones", () => {
    // The clamp moves which days are RETURNED; it must not move which day the
    // half applies to. A span ending 3 Sep in the morning, read over a range
    // that stops on the 2nd, has no half day in it at all.
    const days = expandLeaveDays(
      [
        span({
          start_date: "2026-08-28",
          end_date: "2026-09-03",
          start_half: "AFTERNOON",
          end_half: "MORNING",
        }),
      ],
      "2026-09-01",
      "2026-09-02",
    );

    expect(days.get(leaveKey(ALICE, "2026-09-01"))?.portion).toBe("full");
    expect(days.get(leaveKey(ALICE, "2026-09-02"))?.portion).toBe("full");
    expect(days.has(leaveKey(ALICE, "2026-09-03"))).toBe(false);
  });

  it("returns nothing for a span outside the range", () => {
    const days = expandLeaveDays(
      [span({ start_date: "2026-07-01", end_date: "2026-07-05" })],
      "2026-08-01",
      "2026-08-31",
    );

    expect(days.size).toBe(0);
  });

  it("returns nothing for a range that runs backwards", () => {
    // Not an error, and deliberately not silently swapped: the DTR page says so
    // in words instead, and expanding an inverted range would be a walk with no
    // end.
    const days = expandLeaveDays([span()], "2026-08-31", "2026-08-01");

    expect(days.size).toBe(0);
  });
});

describe("describeLeaveDay — what payroll reads", () => {
  it("names a whole day with its type", () => {
    expect(describeLeaveDay({ portion: "full", typeNames: ["Vacation leave"] })).toBe(
      "Full day — Vacation leave",
    );
  });

  it("names which half", () => {
    expect(describeLeaveDay({ portion: "morning", typeNames: ["Sick leave"] })).toBe(
      "Half day (morning) — Sick leave",
    );
    expect(describeLeaveDay({ portion: "afternoon", typeNames: ["Sick leave"] })).toBe(
      "Half day (afternoon) — Sick leave",
    );
  });

  it("says what it knows when the type was never recorded", () => {
    // Rows that predate P7-12 have no leave type. "Full day" alone is the whole
    // of what that row states, and inventing a type would be worse than a
    // shorter sentence.
    expect(describeLeaveDay({ portion: "full", typeNames: [] })).toBe("Full day");
  });
});

import { describe, expect, it } from "vitest";

/**
 * P7-53 — the Mode B clipping rule.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE FILE. The rule lives in SQL, inside
 * `vizserve_pms_leave_taken` (20260901090100_p7_53_leave_report_filters.sql).
 * `tests/db/*` cannot run against the production project this repo is pointed
 * at, so THESE TESTS DO NOT PROVE THE SQL. What they do is state the intended
 * answers, by hand, so that:
 *
 *   1. the rule is written down somewhere executable rather than only in a
 *      comment, and
 *   2. the first PDF off the real database has something to be checked against
 *      — the expectations below are the numbers it should produce.
 *
 * `clipWindow` is a transcription of the SQL's `case` expressions. If the two
 * ever disagree, the SQL is right and this file is the bug — but a
 * disagreement is exactly what this is here to make visible.
 */

type DayHalf = "MORNING" | "AFTERNOON";

type LeaveRequest = {
  start_date: string;
  end_date: string;
  start_half: DayHalf | null;
  end_half: DayHalf | null;
};

type Clipped = {
  countedFrom: string;
  countedTo: string;
  startHalf: DayHalf;
  endHalf: DayHalf;
  isClipped: boolean;
};

/**
 * The transcription. Compare line for line with the SQL:
 *
 *   greatest(r.start_date, p_from),
 *   least(r.end_date, p_to),
 *   case when r.start_date >= p_from then coalesce(r.start_half, 'MORNING')
 *        else 'MORNING' end,
 *   case when r.end_date <= p_to then coalesce(r.end_half, 'AFTERNOON')
 *        else 'AFTERNOON' end
 *
 * Dates are compared as STRINGS, which is correct only because `YYYY-MM-DD`
 * sorts lexicographically — the same property `lib/dates.ts` and the calendar
 * both rely on, and the reason no value here is ever passed through `Date`.
 */
function clipWindow(request: LeaveRequest, from: string, to: string): Clipped {
  const countedFrom = request.start_date > from ? request.start_date : from;
  const countedTo = request.end_date < to ? request.end_date : to;

  return {
    countedFrom,
    countedTo,
    startHalf: request.start_date >= from ? (request.start_half ?? "MORNING") : "MORNING",
    endHalf: request.end_date <= to ? (request.end_half ?? "AFTERNOON") : "AFTERNOON",
    isClipped: request.start_date < from || request.end_date > to,
  };
}

const WINDOW = { from: "2026-03-01", to: "2026-03-31" };

describe("Mode B clipping — days are counted for the OVERLAP", () => {
  it("leaves a request wholly inside the window untouched", () => {
    const result = clipWindow(
      {
        start_date: "2026-03-10",
        end_date: "2026-03-12",
        start_half: "AFTERNOON",
        end_half: "MORNING",
      },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result).toEqual({
      countedFrom: "2026-03-10",
      countedTo: "2026-03-12",
      // Both markers survive, because both ends are genuinely this request's.
      startHalf: "AFTERNOON",
      endHalf: "MORNING",
      isClipped: false,
    });
  });

  it("⚠️ DROPS THE END MARKER when the end is clipped away", () => {
    // The failure this whole test file exists for. The request finishes on a
    // MORNING half-day on 2 April; the window ends on 31 March. 31 March is no
    // longer the request's end, so it must be counted as a WHOLE day — the
    // person really is away all of it. Carrying "MORNING" across would count a
    // half day at a boundary that is not a boundary, and the report would
    // silently lose half a day for every such request.
    const result = clipWindow(
      {
        start_date: "2026-03-30",
        end_date: "2026-04-02",
        start_half: "MORNING",
        end_half: "MORNING",
      },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.countedTo).toBe("2026-03-31");
    expect(result.endHalf).toBe("AFTERNOON");
    expect(result.startHalf).toBe("MORNING");
    expect(result.isClipped).toBe(true);
  });

  it("⚠️ DROPS THE START MARKER when the start is clipped away", () => {
    // The mirror image. Leave began on 25 February in the AFTERNOON; by 1 March
    // the person has been away for days, so the first day inside the window is
    // a whole one.
    const result = clipWindow(
      {
        start_date: "2026-02-25",
        end_date: "2026-03-04",
        start_half: "AFTERNOON",
        end_half: "AFTERNOON",
      },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.countedFrom).toBe("2026-03-01");
    expect(result.startHalf).toBe("MORNING");
    // The end is inside the window, so ITS marker survives.
    expect(result.endHalf).toBe("AFTERNOON");
    expect(result.isClipped).toBe(true);
  });

  it("drops BOTH markers for a request clipped at both ends", () => {
    const result = clipWindow(
      {
        start_date: "2026-02-20",
        end_date: "2026-04-10",
        start_half: "AFTERNOON",
        end_half: "MORNING",
      },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result).toEqual({
      countedFrom: "2026-03-01",
      countedTo: "2026-03-31",
      startHalf: "MORNING",
      endHalf: "AFTERNOON",
      isClipped: true,
    });
  });

  it("keeps a marker that lands exactly ON the boundary", () => {
    // The off-by-one. The SQL uses `>=` and `<=`, not `>` and `<`: a request
    // starting on the very first day of the window has NOT been clipped, so its
    // half-day marker is still describing its own real edge.
    const result = clipWindow(
      {
        start_date: "2026-03-01",
        end_date: "2026-03-31",
        start_half: "AFTERNOON",
        end_half: "MORNING",
      },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.startHalf).toBe("AFTERNOON");
    expect(result.endHalf).toBe("MORNING");
    expect(result.isClipped).toBe(false);
  });

  it("defaults a NULL marker to the whole-day reading", () => {
    // start_half and end_half are nullable (p7_16:28-29) — a request filed
    // before P7-16, or one that never specified halves. Without the coalesce a
    // null would propagate out of the case and into leave_days, and the row's
    // day count would come back null rather than wrong, which at least fails
    // loudly — but the coalesce is what makes it simply correct.
    const result = clipWindow(
      { start_date: "2026-03-05", end_date: "2026-03-06", start_half: null, end_half: null },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.startHalf).toBe("MORNING");
    expect(result.endHalf).toBe("AFTERNOON");
    expect(result.isClipped).toBe(false);
  });

  it("treats a single-day request as its own both-ends case", () => {
    const result = clipWindow(
      {
        start_date: "2026-03-15",
        end_date: "2026-03-15",
        start_half: "AFTERNOON",
        end_half: "AFTERNOON",
      },
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.countedFrom).toBe("2026-03-15");
    expect(result.countedTo).toBe("2026-03-15");
    expect(result.startHalf).toBe("AFTERNOON");
    expect(result.endHalf).toBe("AFTERNOON");
    expect(result.isClipped).toBe(false);
  });
});

describe("Mode B overlap — overlap, never containment", () => {
  /** The `where` clause: `r.start_date <= p_to and r.end_date >= p_from`. */
  function overlaps(request: { start_date: string; end_date: string }, from: string, to: string) {
    return request.start_date <= to && request.end_date >= from;
  }

  it("includes leave that straddles the start of the window", () => {
    expect(overlaps({ start_date: "2026-02-25", end_date: "2026-03-02" }, WINDOW.from, WINDOW.to))
      .toBe(true);
  });

  it("includes leave that straddles the end of the window", () => {
    expect(overlaps({ start_date: "2026-03-30", end_date: "2026-04-03" }, WINDOW.from, WINDOW.to))
      .toBe(true);
  });

  it("includes leave that swallows the window whole", () => {
    // Containment logic would drop this one, and it is the person who was away
    // for the entire period the report covers.
    expect(overlaps({ start_date: "2026-01-01", end_date: "2026-12-31" }, WINDOW.from, WINDOW.to))
      .toBe(true);
  });

  it("excludes leave that ends the day before the window", () => {
    expect(overlaps({ start_date: "2026-02-01", end_date: "2026-02-28" }, WINDOW.from, WINDOW.to))
      .toBe(false);
  });

  it("includes leave that ends on the first day of the window", () => {
    expect(overlaps({ start_date: "2026-02-01", end_date: "2026-03-01" }, WINDOW.from, WINDOW.to))
      .toBe(true);
  });
});

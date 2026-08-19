import { describe, expect, it } from "vitest";

import { formatWeekRange, formatWeekday, startOfWeek, weekDates } from "@/lib/dates";
import {
  addMinutesToTime,
  cellCommit,
  dayState,
  daySummary,
  formatCellDuration,
  fromMinutes,
  minutesBetween,
  parseCellDuration,
  isWeekLocked,
  timesheetEntrySchema,
  timesheetEntryUpdateSchema,
  timesheetWeekDecisionSchema,
  toMinutes,
} from "@/lib/schemas/timesheet";

/**
 * P6-01 / P6-02 — the timesheet's pure logic.
 *
 * Two things are worth testing without a database. The week helpers, because
 * `lib/dates.ts` is where an off-by-one day hides and a week boundary is the
 * easiest one to get wrong. And the entry schema, because `task_id` being
 * required IS the feature (docs/09, Amier 33:20) — a refactor that quietly
 * makes it optional should fail here rather than in production, where the
 * symptom is untraceable hours.
 */

describe("startOfWeek — Monday, and Sunday belongs to the week that ended", () => {
  it("returns the same day when it is already a Monday", () => {
    // 2026-08-03 is a Monday.
    expect(startOfWeek("2026-08-03")).toBe("2026-08-03");
  });

  it("walks back to Monday from mid-week", () => {
    expect(startOfWeek("2026-08-06")).toBe("2026-08-03"); // Thursday
  });

  it("puts Sunday at the END of its week, not the start of the next", () => {
    // The bug this guards: getUTCDay() is 0 for Sunday, so the naive
    // `weekday - 1` sends it forward a day into the following week and a
    // Sunday's hours land on a timesheet nobody is looking at.
    expect(startOfWeek("2026-08-09")).toBe("2026-08-03");
  });

  it("crosses a month boundary", () => {
    // 2026-08-01 is a Saturday, so its Monday is in July.
    expect(startOfWeek("2026-08-01")).toBe("2026-07-27");
  });

  it("returns null for something that is not a date", () => {
    expect(startOfWeek("banana")).toBeNull();
  });
});

describe("weekDates", () => {
  it("returns seven consecutive days, Monday first", () => {
    expect(weekDates("2026-08-06")).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
  });

  it("gives the same week for every day in it", () => {
    const fromMonday = weekDates("2026-08-03");
    for (const day of fromMonday) {
      expect(weekDates(day)).toEqual(fromMonday);
    }
  });
});

describe("formatWeekday — reads the calendar date, not the server's zone", () => {
  it("names the weekday", () => {
    expect(formatWeekday("2026-08-03")).toBe("Mon");
    expect(formatWeekday("2026-08-09")).toBe("Sun");
  });
});

describe("formatWeekRange", () => {
  it("collapses the month when both ends share it", () => {
    expect(formatWeekRange("2026-08-03")).toBe("3 – 9 Aug 2026");
  });

  it("keeps the month when the week spans two", () => {
    expect(formatWeekRange("2026-07-27")).toBe("27 Jul – 2 Aug 2026");
  });
});

describe("toMinutes — hours and minutes, never a decimal", () => {
  it("adds the two fields", () => {
    expect(toMinutes("2", "30")).toBe(150);
    expect(toMinutes("1", "")).toBe(60);
    expect(toMinutes("", "45")).toBe(45);
  });

  it("returns null for nothing entered, so blank stays distinct from zero", () => {
    expect(toMinutes("", "")).toBeNull();
    expect(toMinutes("0", "0")).toBe(0);
  });

  it("refuses negatives rather than subtracting time", () => {
    expect(toMinutes("-1", "0")).toBeNull();
    expect(toMinutes("1", "-30")).toBeNull();
  });

  it("round-trips through fromMinutes", () => {
    for (const total of [1, 45, 60, 150, 480, 1440]) {
      const parts = fromMinutes(total);
      expect(toMinutes(parts.hours, parts.minutes)).toBe(total);
    }
  });
});

describe("parseCellDuration — one field, in a grid", () => {
  it("REFUSES the colon form rather than guessing at it", () => {
    // `1:30` used to read as ninety minutes. It looks like a clock, so half the
    // people typing it mean one-thirty and the other half mean a minute and
    // thirty seconds. On a record that feeds approval and payroll, a format
    // that is read backwards by anyone is worse than no format.
    expect(parseCellDuration("1:30")).toBeNull();
    expect(parseCellDuration("0:45")).toBeNull();
    expect(parseCellDuration("12:00")).toBeNull();
    expect(parseCellDuration("1:30:05")).toBeNull();
  });

  it("reads a bare number as HOURS, which is the whole ambiguity", () => {
    expect(parseCellDuration("2")).toBe(120);
    expect(parseCellDuration("1.5")).toBe(90);
    expect(parseCellDuration("0.25")).toBe(15);
  });

  it("reads explicit units", () => {
    expect(parseCellDuration("90m")).toBe(90);
    expect(parseCellDuration("2h")).toBe(120);
    expect(parseCellDuration("1h30m")).toBe(90);
    expect(parseCellDuration("1h30")).toBe(90);
    expect(parseCellDuration("1h 30m")).toBe(90);
    expect(parseCellDuration("1.5h")).toBe(90);
  });

  it("treats empty as zero — clearing a cell is an instruction, not a mistake", () => {
    expect(parseCellDuration("")).toBe(0);
    expect(parseCellDuration("   ")).toBe(0);
    expect(parseCellDuration("0")).toBe(0);
  });

  it("returns null for input that means nothing, so the cell can say so", () => {
    expect(parseCellDuration("banana")).toBeNull();
    expect(parseCellDuration("h")).toBeNull();
    expect(parseCellDuration("-1")).toBeNull();
    expect(parseCellDuration("1:75")).toBeNull();
    expect(parseCellDuration("::")).toBeNull();
    // The scanner must CONSUME the string, not match a prefix of it. This is
    // the case a non-sticky regex silently accepts as 60 minutes.
    expect(parseCellDuration("1h banana")).toBeNull();
    expect(parseCellDuration("90m!!")).toBeNull();
  });

  it("reads seconds, and says so in minutes because that is what it stores", () => {
    expect(parseCellDuration("1h 30m 5s")).toBe(90);
    expect(parseCellDuration("1h30m5s")).toBe(90);

    // Accumulated in seconds and rounded ONCE. Rounding per unit would make
    // these two disagree, and both are the same length of time.
    expect(parseCellDuration("1h 30m 40s")).toBe(parseCellDuration("90m 40s"));

    // Under half a minute has nowhere to go: the column is minutes.
    expect(parseCellDuration("45s")).toBe(1);
    expect(parseCellDuration("29s")).toBe(0);
  });

  it("accepts the long spellings people actually type", () => {
    expect(parseCellDuration("1 hour 30 minutes")).toBe(90);
    expect(parseCellDuration("2 hrs")).toBe(120);
    expect(parseCellDuration("90 mins")).toBe(90);
    expect(parseCellDuration("30 secs")).toBe(1);
  });

  it("refuses more than a day, which the CHECK constraint would refuse anyway", () => {
    expect(parseCellDuration("24h")).toBe(1440);
    expect(parseCellDuration("24h 1m")).toBeNull();
    expect(parseCellDuration("25")).toBeNull();
  });

  it("round-trips through formatCellDuration", () => {
    for (const total of [1, 45, 60, 90, 150, 480, 1440]) {
      expect(parseCellDuration(formatCellDuration(total))).toBe(total);
    }
  });

  it("writes the same units it reads, so a cell can be retyped as shown", () => {
    expect(formatCellDuration(45)).toBe("45m");
    expect(formatCellDuration(60)).toBe("1h");
    expect(formatCellDuration(150)).toBe("2h 30m");
    expect(formatCellDuration(480)).toBe("8h");
  });
});

describe("timesheetEntrySchema — task_id is the feature", () => {
  const valid = {
    task_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    work_date: "2026-08-06",
    minutes: 90,
    note: "second round",
  };

  it("accepts a complete entry", () => {
    expect(timesheetEntrySchema.safeParse(valid).success).toBe(true);
  });

  it("REJECTS an entry with no task — free-text logging is forbidden", () => {
    const withoutTask = { work_date: valid.work_date, minutes: valid.minutes, note: valid.note };
    expect(timesheetEntrySchema.safeParse(withoutTask).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, task_id: null }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, task_id: "" }).success).toBe(false);
  });

  it("rejects zero, negative and longer-than-a-day durations", () => {
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 0 }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: -30 }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 1441 }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 1440 }).success).toBe(true);
  });

  it("rejects fractional minutes", () => {
    expect(timesheetEntrySchema.safeParse({ ...valid, minutes: 90.5 }).success).toBe(false);
  });

  it("normalises a blank note to null, which is what the CHECK constraint wants", () => {
    const parsed = timesheetEntrySchema.parse({ ...valid, note: "   " });
    expect(parsed.note).toBeNull();
  });
});

describe("dayState — advisory, and overtime raises the bar rather than removing it", () => {
  it("says nothing about an empty day", () => {
    expect(dayState(0)).toBe("empty");
    expect(dayState(0, 120)).toBe("empty");
  });

  it("is normal right up to eight hours", () => {
    expect(dayState(1)).toBe("normal");
    expect(dayState(479)).toBe("normal");
    expect(dayState(480)).toBe("normal");
  });

  it("flags the first minute past eight with no approval", () => {
    expect(dayState(481)).toBe("over");
    expect(dayState(600)).toBe("over");
  });

  it("reads as overtime while it stays inside what was approved", () => {
    expect(dayState(481, 60)).toBe("overtime");
    expect(dayState(540, 60)).toBe("overtime");
  });

  it("still flags the part nobody signed off", () => {
    // 60 approved takes the bar to 9h. 9h01 is over it again.
    expect(dayState(541, 60)).toBe("over");
  });

  it("treats approved overtime on a short day as irrelevant", () => {
    expect(dayState(300, 240)).toBe("normal");
  });
});

describe("P7-21 — start and end times on an entry", () => {
  const base = {
    task_id: "11111111-1111-4111-8111-111111111111",
    work_date: "2026-08-19",
    minutes: 150,
  };

  it("accepts an entry with no times at all, which is still the ordinary case", () => {
    const parsed = timesheetEntrySchema.safeParse(base);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.started_at).toBeNull();
      expect(parsed.data.ended_at).toBeNull();
    }
  });

  it("treats an empty string as no time rather than a malformed one", () => {
    // A cleared input sends "", and rejecting that as "not a time" would make
    // removing the times impossible.
    const parsed = timesheetEntrySchema.safeParse({ ...base, started_at: "", ended_at: "" });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.started_at).toBeNull();
  });

  it("accepts a matching pair", () => {
    const parsed = timesheetEntrySchema.safeParse({
      ...base,
      started_at: "09:00",
      ended_at: "11:30",
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses half a pair", () => {
    // Mirrors vizserve_pms_timesheet_entries_times_paired. A start with no end
    // is an open interval and this table has no concept of one.
    expect(timesheetEntrySchema.safeParse({ ...base, started_at: "09:00" }).success).toBe(false);
    expect(timesheetEntrySchema.safeParse({ ...base, ended_at: "11:30" }).success).toBe(false);
  });

  it("refuses an end before the start", () => {
    expect(
      timesheetEntrySchema.safeParse({ ...base, started_at: "11:30", ended_at: "09:00" }).success,
    ).toBe(false);
  });

  it("refuses a zero-length span", () => {
    expect(
      timesheetEntrySchema.safeParse({ ...base, started_at: "09:00", ended_at: "09:00" }).success,
    ).toBe(false);
  });

  it("refuses a duration that disagrees with the times", () => {
    // The whole point of the constraint behind this: a row saying "09:00 to
    // 11:30, 45 minutes" makes both numbers untrustworthy on every row.
    const parsed = timesheetEntrySchema.safeParse({
      ...base,
      minutes: 45,
      started_at: "09:00",
      ended_at: "11:30",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a time that is not a time", () => {
    expect(
      timesheetEntrySchema.safeParse({ ...base, started_at: "9am", ended_at: "11:30" }).success,
    ).toBe(false);
    expect(
      timesheetEntrySchema.safeParse({ ...base, started_at: "25:00", ended_at: "26:00" }).success,
    ).toBe(false);
  });

  it("applies the same rules when editing an existing row", () => {
    // The update schema is built from the same shape through the same helper,
    // so the two cannot drift into checking different things.
    const id = "22222222-2222-4222-8222-222222222222";

    expect(
      timesheetEntryUpdateSchema.safeParse({ ...base, id, started_at: "09:00", ended_at: "11:30" })
        .success,
    ).toBe(true);
    expect(timesheetEntryUpdateSchema.safeParse({ ...base, id, started_at: "09:00" }).success).toBe(
      false,
    );
  });
});

describe("minutesBetween / addMinutesToTime", () => {
  it("measures a span on one day", () => {
    expect(minutesBetween("09:00", "11:30")).toBe(150);
    expect(minutesBetween("00:00", "23:59")).toBe(1439);
  });

  it("goes negative rather than wrapping, so the caller can refuse it", () => {
    // Wrapping would silently turn "22:00 to 01:00" into a three-hour entry on
    // a day the second half did not happen. Q8 is still open on overnight work
    // and this refuses to guess.
    expect(minutesBetween("22:00", "01:00")).toBeLessThan(0);
  });

  it("adds minutes to a clock time", () => {
    expect(addMinutesToTime("09:00", 150)).toBe("11:30");
    expect(addMinutesToTime("09:05", 55)).toBe("10:00");
  });

  it("refuses to run past midnight", () => {
    expect(addMinutesToTime("23:00", 120)).toBeNull();
  });
});

describe("daySummary — the figures both grids read", () => {
  it("puts capacity at the standard day when nothing was approved", () => {
    const summary = daySummary(480);

    expect(summary.capacityMinutes).toBe(480);
    expect(summary.trackedMinutes).toBe(480);
    expect(summary.overMinutes).toBe(0);
    expect(summary.percentOfCapacity).toBe(100);
  });

  it("raises capacity by the overtime approved for that day", () => {
    // The rule the whole overtime approval flow exists to express: 8h plus
    // whatever a lead signed off, per day.
    expect(daySummary(0, 120).capacityMinutes).toBe(600);
  });

  it("names how far past capacity a day ran", () => {
    // The number that was previously only spoken to a screen reader. Nine
    // hours with nothing approved is one hour over.
    const summary = daySummary(540);

    expect(summary.state).toBe("over");
    expect(summary.overMinutes).toBe(60);
    expect(summary.percentOfCapacity).toBe(113);
  });

  it("is over by nothing while the day sits inside its approved overtime", () => {
    const summary = daySummary(540, 120);

    expect(summary.state).toBe("overtime");
    expect(summary.overMinutes).toBe(0);
  });

  it("counts only the part nobody signed off", () => {
    // 10h logged, 1h approved. The overage is the hour past 9h, not the two
    // past 8h — approved overtime raises the bar rather than removing it.
    const summary = daySummary(600, 60);

    expect(summary.state).toBe("over");
    expect(summary.overMinutes).toBe(60);
  });

  it("never reports a negative overage on a short day", () => {
    const summary = daySummary(120);

    expect(summary.state).toBe("normal");
    expect(summary.overMinutes).toBe(0);
  });

  it("reports an empty day as zero rather than dividing into a percentage", () => {
    const summary = daySummary(0);

    expect(summary.state).toBe("empty");
    expect(summary.percentOfCapacity).toBe(0);
    expect(summary.overMinutes).toBe(0);
  });

  it("agrees with dayState, because it is the same decision", () => {
    for (const [total, granted] of [
      [0, 0],
      [480, 0],
      [481, 0],
      [540, 60],
      [541, 60],
      [600, 120],
    ] as const) {
      expect(daySummary(total, granted).state).toBe(dayState(total, granted));
    }
  });
});

describe("isWeekLocked", () => {
  it("locks a submitted or approved week and frees a returned one", () => {
    expect(isWeekLocked("SUBMITTED")).toBe(true);
    expect(isWeekLocked("APPROVED")).toBe(true);
    expect(isWeekLocked("RETURNED")).toBe(false);
    // No row at all is the draft state.
    expect(isWeekLocked(null)).toBe(false);
  });
});

describe("timesheetWeekDecisionSchema — approve or send back, never reject", () => {
  it("takes an approval with no reason", () => {
    expect(timesheetWeekDecisionSchema.safeParse({ decision: "approved" }).success).toBe(true);
  });

  it("demands a reason to send a week back", () => {
    expect(timesheetWeekDecisionSchema.safeParse({ decision: "returned" }).success).toBe(false);
    expect(
      timesheetWeekDecisionSchema.safeParse({ decision: "returned", reason: "  " }).success,
    ).toBe(false);
    expect(
      timesheetWeekDecisionSchema.safeParse({ decision: "returned", reason: "Tuesday is wrong" })
        .success,
    ).toBe(true);
  });

  it("has no rejected branch — hours worked are not rejectable", () => {
    expect(
      timesheetWeekDecisionSchema.safeParse({ decision: "rejected", reason: "no thanks" }).success,
    ).toBe(false);
  });
});

/**
 * SLICE H — the commit decision, lifted out of the cell so it can be tested.
 *
 * These branches used to be four early `return`s inside a blur handler, which is
 * not where a rule about deleting somebody's timesheet entry belongs. They are
 * also what the unmount and `visibilitychange` flushes call, and neither of those
 * can read component state — so this being pure is a requirement, not a tidy-up.
 */
describe("cellCommit — what a typed cell means", () => {
  it("inserts when the cell was empty and a duration was typed", () => {
    expect(cellCommit("2h", { total: 0, entryCount: 0 })).toEqual({
      kind: "insert",
      minutes: 120,
    });
  });

  it("updates when an entry exists and the length changed", () => {
    expect(cellCommit("90m", { total: 120, entryCount: 1 })).toEqual({
      kind: "update",
      minutes: 90,
    });
  });

  it("deletes when an existing entry is cleared", () => {
    // Empty parses as 0, and 0 against an existing entry means "remove it" —
    // which is why `parseCellDuration` returns 0 for empty rather than null.
    expect(cellCommit("", { total: 120, entryCount: 1 })).toEqual({ kind: "delete" });
  });

  it("is a noop when the number did not change", () => {
    // A no-change UPDATE still bumps `updated_at`, so every tab through a week
    // would look like an edit in the audit trail.
    expect(cellCommit("2h", { total: 120, entryCount: 1 })).toEqual({ kind: "noop" });
  });

  it("is a noop when an empty cell is left empty", () => {
    expect(cellCommit("", { total: 0, entryCount: 0 })).toEqual({ kind: "noop" });
  });

  it("never reaches `delete` with nothing to delete", () => {
    // The unchanged check runs before the empty case, so clearing an
    // already-empty cell cannot produce a delete against `entries[0]`.
    expect(cellCommit("0m", { total: 0, entryCount: 0 }).kind).not.toBe("delete");
  });

  it("reports invalid input and hands the typed string back", () => {
    // Handed back because the caller keeps the draft on screen — a toast
    // explaining a value the cell no longer shows explains nothing.
    expect(cellCommit("1:30", { total: 0, entryCount: 0 })).toEqual({
      kind: "invalid",
      typed: "1:30",
    });
    expect(cellCommit("lunch", { total: 0, entryCount: 0 }).kind).toBe("invalid");
  });

  it("reads a bare number as hours, like the cell it came from", () => {
    // The whole reason the estimate field and this share a parser: `1.5` has to
    // mean the same 90 minutes in both places.
    expect(cellCommit("1.5", { total: 0, entryCount: 0 })).toEqual({
      kind: "insert",
      minutes: 90,
    });
  });

  it("treats an abandoned draft that means nothing as nothing to write", () => {
    // The draft-safety rule: a flush on unmount asks this same question, and
    // `invalid` and `noop` are both "drop it". A cell abandoned mid-word must not
    // become a write nobody reviewed — `1:` is half of `1:30`, and a parser that
    // guessed at it would write an hour somebody never confirmed.
    for (const typed of ["1:", "h", "1h 3x"]) {
      expect(cellCommit(typed, { total: 60, entryCount: 1 }).kind).toBe("invalid");
    }
  });

  it("reads whitespace as a deliberate clear, not as an abandoned draft", () => {
    // `parseCellDuration` trims and returns 0 for empty, because "clear this
    // cell" is a real instruction. So spaces against an existing entry ARE a
    // delete, and that is worth pinning down rather than leaving to be
    // discovered: a flush treats it the same way blur always has.
    expect(cellCommit("   ", { total: 60, entryCount: 1 })).toEqual({ kind: "delete" });
  });
});

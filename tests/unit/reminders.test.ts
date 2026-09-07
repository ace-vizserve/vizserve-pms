import { describe, expect, it } from "vitest";

import { describeReminder, dueReminder, reminderSeenKey } from "@/lib/reminders";

/**
 * P8-12 — the arithmetic behind every clock reminder in the app.
 *
 * ⚠️ NO INSTANTS IN THIS FILE, AND THAT IS THE DESIGN. `dueReminder` takes an
 * `HH:MM` string that the CALLER has already brought into Manila through
 * `formatAppTime`, so there is no timezone left inside the function to get
 * wrong — which is exactly why these tests can assert what happens at 08:45
 * without any clock mocking, and why the zone trap that
 * `tests/unit/dtr-schedule.test.ts` spends its header on cannot recur here.
 *
 * The one thing that CAN go wrong is the window boundary, so most of what
 * follows is the four minutes either side of it.
 */

/** A 09:00–18:00 day, both reminders on, nothing punched, a working day. */
const base = {
  nowClock: "08:45",
  workStart: "09:00",
  workEnd: "18:00",
  timeIn: null as string | null,
  timeOut: null as string | null,
  clockInLeadMinutes: 15,
  clockOutLeadMinutes: 15,
  clockIn: true,
  clockOut: true,
  working: true,
};

/** Timed in at 09:00 Manila and not out — the state the out-reminder needs. */
const CLOCKED_IN = "2026-09-04T01:00:00Z";

describe("dueReminder — the clock-in window", () => {
  it("fires exactly at the lead time", () => {
    expect(dueReminder(base)).toEqual({ side: "in", scheduled: "09:00", minutesAway: 15 });
  });

  it("stays silent one minute before the window opens", () => {
    expect(dueReminder({ ...base, nowClock: "08:44" })).toBeNull();
  });

  it("still fires one minute before the scheduled start", () => {
    expect(dueReminder({ ...base, nowClock: "08:59" })).toEqual({
      side: "in",
      scheduled: "09:00",
      minutesAway: 1,
    });
  });

  /**
   * THE EXCLUSIVE END IS DELIBERATE. At 09:00 the moment to remind somebody has
   * passed; what they need then is the lateness prompt the DTR already gives
   * them after the punch, not a warning about a start that has already started.
   */
  it("goes quiet at the scheduled start itself", () => {
    expect(dueReminder({ ...base, nowClock: "09:00" })).toBeNull();
  });

  it("says nothing once they have timed in", () => {
    expect(dueReminder({ ...base, timeIn: CLOCKED_IN })).toBeNull();
  });

  it("says nothing when the clock-in toggle is off", () => {
    expect(dueReminder({ ...base, clockIn: false })).toBeNull();
  });
});

describe("dueReminder — the clock-out window", () => {
  const working = { ...base, nowClock: "17:45", timeIn: CLOCKED_IN };

  it("fires at the lead time when the shift is open", () => {
    expect(dueReminder(working)).toEqual({ side: "out", scheduled: "18:00", minutesAway: 15 });
  });

  it("stays silent one minute before the window opens", () => {
    expect(dueReminder({ ...working, nowClock: "17:44" })).toBeNull();
  });

  it("goes quiet at the scheduled finish itself", () => {
    expect(dueReminder({ ...working, nowClock: "18:00" })).toBeNull();
  });

  /** No time-in means there is no shift in progress to close. */
  it("says nothing when they never timed in", () => {
    expect(dueReminder({ ...working, timeIn: null })).toBeNull();
  });

  it("says nothing once they have timed out", () => {
    expect(dueReminder({ ...working, timeOut: "2026-09-04T09:50:00Z" })).toBeNull();
  });

  it("says nothing when the clock-out toggle is off", () => {
    expect(dueReminder({ ...working, clockOut: false })).toBeNull();
  });

  /**
   * ⚠️ THE OVERTIME CASE, and the reason `workEnd` arrives pre-extended.
   *
   * `effectiveEnd("18:00", 120)` is "20:00", so on an evening somebody's lead
   * approved two extra hours for, 17:45 is no longer near the end of their day
   * and nothing should be said. Passing the raw `work_end` here would nag them
   * about doing exactly what they were authorised to do.
   */
  it("respects an end already extended by approved overtime", () => {
    expect(dueReminder({ ...working, workEnd: "20:00" })).toBeNull();
    expect(dueReminder({ ...working, nowClock: "19:45", workEnd: "20:00" })).toEqual({
      side: "out",
      scheduled: "20:00",
      minutesAway: 15,
    });
  });
});

describe("dueReminder — the silences", () => {
  it("says nothing on a day nobody is expected to work", () => {
    expect(dueReminder({ ...base, working: false })).toBeNull();
  });

  /**
   * P7-36's null schedule is a supported state — "this person works no fixed
   * hours" — and the DTR already says nothing about their punches. So does this.
   */
  it("says nothing for somebody with no schedule", () => {
    expect(dueReminder({ ...base, workStart: null, workEnd: null })).toBeNull();
  });

  it("says nothing for an unparseable clock value", () => {
    expect(dueReminder({ ...base, nowClock: "not a time" })).toBeNull();
    expect(dueReminder({ ...base, workStart: "25:00" })).toBeNull();
  });

  /**
   * A lead time outside the legal range is a corrupt read, not an instruction.
   * Refusing to fire says nothing; falling back to 15 would invent a policy the
   * person never chose.
   */
  it("says nothing for a lead time below one minute", () => {
    expect(dueReminder({ ...base, clockInLeadMinutes: 0 })).toBeNull();
    expect(dueReminder({ ...base, clockInLeadMinutes: -5 })).toBeNull();
    expect(dueReminder({ ...base, clockInLeadMinutes: Number.NaN })).toBeNull();
  });
});

describe("dueReminder — the lead-time extremes", () => {
  it("honours a one-minute lead", () => {
    expect(dueReminder({ ...base, clockInLeadMinutes: 1, nowClock: "08:59" })).toEqual({
      side: "in",
      scheduled: "09:00",
      minutesAway: 1,
    });
    expect(dueReminder({ ...base, clockInLeadMinutes: 1, nowClock: "08:58" })).toBeNull();
  });

  it("honours a two-hour lead", () => {
    expect(dueReminder({ ...base, clockInLeadMinutes: 120, nowClock: "07:00" })).toEqual({
      side: "in",
      scheduled: "09:00",
      minutesAway: 120,
    });
    expect(dueReminder({ ...base, clockInLeadMinutes: 120, nowClock: "06:59" })).toBeNull();
  });
});

describe("dueReminder — precedence", () => {
  /**
   * The two windows cannot overlap in any sane schedule, but a shift left open
   * makes the state reachable: `timeIn` set, `timeOut` null, and the clock back
   * round near a start time. Asking about the shift in progress is the more
   * useful of the two questions — and telling somebody to clock IN while the
   * app also believes they are still clocked in reads as a bug.
   */
  it("prefers the shift in progress when both could apply", () => {
    const overlapping = {
      ...base,
      nowClock: "08:45",
      workStart: "09:00",
      workEnd: "09:00",
      timeIn: CLOCKED_IN,
    };

    expect(dueReminder(overlapping)?.side).toBe("out");
  });
});

describe("describeReminder", () => {
  it("names the time as well as the countdown", () => {
    expect(describeReminder({ side: "in", scheduled: "09:00", minutesAway: 15 })).toBe(
      "Clock in at 09:00 — 15 minutes",
    );
    expect(describeReminder({ side: "out", scheduled: "18:00", minutesAway: 1 })).toBe(
      "Clock out at 18:00 — 1 minute",
    );
  });
});

describe("reminderSeenKey", () => {
  /** All three parts are load-bearing — see the note on the function. */
  it("separates person, day and side", () => {
    expect(reminderSeenKey("u1", "2026-09-04", "in")).toBe("vizserve-reminder:u1:2026-09-04:in");
    expect(reminderSeenKey("u1", "2026-09-04", "out")).not.toBe(
      reminderSeenKey("u1", "2026-09-04", "in"),
    );
    expect(reminderSeenKey("u1", "2026-09-05", "in")).not.toBe(
      reminderSeenKey("u1", "2026-09-04", "in"),
    );
    expect(reminderSeenKey("u2", "2026-09-04", "in")).not.toBe(
      reminderSeenKey("u1", "2026-09-04", "in"),
    );
  });
});

/**
 * P11-02 — THE TWO LEADS ARE INDEPENDENT.
 *
 * They were one number subtracted from both ends of the day. The two switches
 * have always been separate, which is what made the shared lead read as an
 * oversight: getting ready to START work takes time and stopping does not, so
 * five minutes before the shift and one before the end is an ordinary thing to
 * want.
 *
 * The whole feature is a browser timer over this pure function — it writes
 * nothing, sends nothing and leaves no record that it fired — so these cases are
 * the entire proof. There is no job to observe and no row to inspect.
 */
describe("dueReminder — one lead per side", () => {
  const split = { ...base, clockInLeadMinutes: 5, clockOutLeadMinutes: 1 };

  it("uses the clock-IN lead for the morning window, not the clock-out one", () => {
    // 08:55 is inside a 5-minute in-window and would be far outside a 1-minute
    // one, so this fails if the sides are crossed.
    expect(dueReminder({ ...split, nowClock: "08:55" })).toEqual({
      side: "in",
      scheduled: "09:00",
      minutesAway: 5,
    });
    expect(dueReminder({ ...split, nowClock: "08:54" })).toBeNull();
  });

  it("uses the clock-OUT lead for the evening window, not the clock-in one", () => {
    const open = { ...split, timeIn: CLOCKED_IN };

    // 17:59 is inside a 1-minute out-window. 17:55 would be inside a 5-minute
    // one, so it fires only if the wrong lead is being read.
    expect(dueReminder({ ...open, nowClock: "17:59" })).toEqual({
      side: "out",
      scheduled: "18:00",
      minutesAway: 1,
    });
    expect(dueReminder({ ...open, nowClock: "17:55" })).toBeNull();
  });

  it("keeps each switch governing its own side", () => {
    // Clock-in off, clock-out on: the morning is silent even though its lead
    // would otherwise have fired.
    expect(dueReminder({ ...split, clockIn: false, nowClock: "08:55" })).toBeNull();

    expect(
      dueReminder({ ...split, clockOut: false, timeIn: CLOCKED_IN, nowClock: "17:59" }),
    ).toBeNull();
  });

  /**
   * ⚠️ A CORRUPT LEAD SILENCES ONE SIDE, NOT BOTH.
   *
   * The check used to run once over a single value, so an out-of-range number
   * killed the whole reminder. With two columns a row can be half-sane, and
   * somebody whose clock-out lead is broken should still be got to work on time.
   */
  it("silences only the side whose lead is unusable", () => {
    const brokenOut = { ...base, clockInLeadMinutes: 15, clockOutLeadMinutes: 0 };

    expect(dueReminder({ ...brokenOut, nowClock: "08:45" })).toEqual({
      side: "in",
      scheduled: "09:00",
      minutesAway: 15,
    });
    expect(
      dueReminder({ ...brokenOut, timeIn: CLOCKED_IN, nowClock: "17:45" }),
    ).toBeNull();
  });

  it("still refuses a lead that is not a number at all", () => {
    expect(dueReminder({ ...base, clockInLeadMinutes: Number.NaN })).toBeNull();
    expect(dueReminder({ ...base, clockInLeadMinutes: -5 })).toBeNull();
  });

  /**
   * The precedence rule is unchanged by the split: an open shift wins. Worth
   * re-asserting with UNEQUAL leads, because that is the arrangement where a
   * crossed pair could make the in-window look like the winner.
   */
  it("still prefers the shift in progress when both could fire", () => {
    const both = {
      ...base,
      clockInLeadMinutes: 120,
      clockOutLeadMinutes: 120,
      timeIn: CLOCKED_IN,
      nowClock: "16:30",
    };
    expect(dueReminder(both)?.side).toBe("out");
  });
});

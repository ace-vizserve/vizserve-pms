import { describe, expect, it } from "vitest";

import {
  correctionTypeFor,
  DEFAULT_GRACE_MINUTES,
  describeDeviation,
  describeDeviationLong,
  deviation,
  effectiveEnd,
  scheduleFor,
} from "@/lib/dtr-schedule";

/**
 * P7-40 — the arithmetic behind every lateness prompt in the app.
 *
 * ⚠️ EVERY INSTANT IN THIS FILE IS WRITTEN IN UTC WITH AN EXPLICIT `Z`, and the
 * Manila offset is applied by hand in the comment beside it. That is the whole
 * point of the suite: the one thing that can go wrong here is a comparison that
 * silently uses the machine's timezone, and a test written in local time would
 * pass on a laptop in Manila and fail in CI — or, worse, pass in both while the
 * production server was eight hours out.
 *
 * Manila is UTC+8, all year, no DST. So 01:06Z is 09:06 Manila.
 */

// 09:06 Manila — six minutes past a 09:00 start.
const NINE_OH_SIX = "2026-08-24T01:06:00Z";
// 09:04 Manila — inside a five-minute grace.
const NINE_OH_FOUR = "2026-08-24T01:04:00Z";
// 09:05 Manila — exactly on the grace boundary.
const NINE_OH_FIVE = "2026-08-24T01:05:00Z";
// 08:40 Manila — early.
const EIGHT_FORTY = "2026-08-24T00:40:00Z";
// 17:30 Manila — half an hour before an 18:00 finish.
const HALF_FIVE = "2026-08-24T09:30:00Z";
// 20:00 Manila — two hours after an 18:00 finish.
const EIGHT_PM = "2026-08-24T12:00:00Z";

describe("scheduleFor", () => {
  it("normalises the HH:MM:SS Postgres returns", () => {
    // The raw column value is never the HH:MM the rest of the module works in.
    expect(scheduleFor({ work_start: "09:00:00", work_end: "18:00:00" })).toEqual({
      workStart: "09:00",
      workEnd: "18:00",
    });
  });

  it("reads no schedule as no schedule", () => {
    expect(scheduleFor({ work_start: null, work_end: null })).toEqual({
      workStart: null,
      workEnd: null,
    });
    expect(scheduleFor({})).toEqual({ workStart: null, workEnd: null });
  });

  it("treats HALF a schedule as none at all", () => {
    // The CHECK constraint refuses this, so it should not exist — but if it
    // ever does, the honest response to "we do not know when this person
    // finishes" is to say nothing about their punches, not to guess.
    expect(scheduleFor({ work_start: "09:00:00", work_end: null }).workStart).toBeNull();
    expect(scheduleFor({ work_start: null, work_end: "18:00:00" }).workEnd).toBeNull();
  });

  it("treats an unparseable value as no schedule", () => {
    expect(scheduleFor({ work_start: "banana", work_end: "18:00:00" })).toEqual({
      workStart: null,
      workEnd: null,
    });
  });
});

describe("deviation", () => {
  it("says nothing when there is no schedule", () => {
    // THE MOST IMPORTANT CASE IN THIS FILE. Somebody who works no fixed hours
    // must never be prompted, however late the clock says they are.
    expect(deviation("in", NINE_OH_SIX, null, 5)).toBeNull();
  });

  it("says nothing when there is no punch", () => {
    expect(deviation("in", null, "09:00", 5)).toBeNull();
    expect(deviation("out", undefined, "18:00", 5)).toBeNull();
  });

  it("flags a time-in past the grace period", () => {
    expect(deviation("in", NINE_OH_SIX, "09:00", 5)).toEqual({
      side: "in",
      minutes: 6,
      scheduled: "09:00",
    });
  });

  it("forgives a time-in inside the grace period", () => {
    expect(deviation("in", NINE_OH_FOUR, "09:00", 5)).toBeNull();
  });

  it("forgives exactly the grace period and flags the minute after", () => {
    // The boundary is inclusive: a five-minute grace forgives five minutes.
    expect(deviation("in", NINE_OH_FIVE, "09:00", 5)).toBeNull();
    expect(deviation("in", NINE_OH_SIX, "09:00", 5)).not.toBeNull();
  });

  it("never flags an EARLY time-in", () => {
    // Arriving at 08:40 for a 09:00 start needs no paperwork. The record is not
    // wrong; the person was early.
    expect(deviation("in", EIGHT_FORTY, "09:00", 5)).toBeNull();
    expect(deviation("in", EIGHT_FORTY, "09:00", 0)).toBeNull();
  });

  it("flags a time-out in BOTH directions", () => {
    // Unlike the start of the day. Leaving early and leaving late are both
    // "the recorded time is not the scheduled one", and Amier's answer was that
    // both are a time-out correction rather than one being overtime.
    expect(deviation("out", HALF_FIVE, "18:00", 5)).toEqual({
      side: "out",
      minutes: -30,
      scheduled: "18:00",
    });
    expect(deviation("out", EIGHT_PM, "18:00", 5)).toEqual({
      side: "out",
      minutes: 120,
      scheduled: "18:00",
    });
  });

  it("treats a grace of zero as exact", () => {
    // Zero is a real policy, not a disabled state.
    expect(deviation("in", "2026-08-24T01:00:00Z", "09:00", 0)).toBeNull();
    expect(deviation("in", "2026-08-24T01:01:00Z", "09:00", 0)).toEqual({
      side: "in",
      minutes: 1,
      scheduled: "09:00",
    });
  });

  it("falls back to the default grace rather than to zero", () => {
    // A missing settings row must not silently make everybody late. Both of
    // these are inside the five-minute default.
    expect(deviation("in", NINE_OH_FOUR, "09:00")).toBeNull();
    expect(deviation("in", NINE_OH_FOUR, "09:00", Number.NaN)).toBeNull();
    expect(DEFAULT_GRACE_MINUTES).toBe(5);
  });

  it("does not read the machine's timezone", () => {
    /*
     * ⚠️ THE REGRESSION GUARD THIS FILE EXISTS FOR.
     *
     * 01:06Z is 09:06 in Manila and 01:06 in UTC. A comparison written with
     * `new Date(x).getHours()` or `.toISOString()` reads this as 01:06 and
     * therefore as 474 minutes EARLY rather than 6 minutes late — which, for a
     * time-in, would come back null and switch lateness reporting off entirely
     * on any server that is not physically in Manila.
     */
    const found = deviation("in", NINE_OH_SIX, "09:00", 5);
    expect(found?.minutes).toBe(6);
    expect(found?.minutes).not.toBe(-474);
  });

  it("handles a punch either side of midnight without wrapping", () => {
    // 23:30 Manila against a 09:00 start is 870 minutes late, not -570. The
    // module does clock arithmetic on one day and never rolls over.
    expect(deviation("in", "2026-08-24T15:30:00Z", "09:00", 5)?.minutes).toBe(870);
  });
});

describe("effectiveEnd", () => {
  it("extends the day by approved overtime", () => {
    // The reason approved overtime belongs in the DTR at all: doing exactly
    // what you were authorised to do must not then read as a deviation.
    expect(effectiveEnd("18:00", 120)).toBe("20:00");
  });

  it("leaves the end alone with no approved overtime", () => {
    expect(effectiveEnd("18:00", 0)).toBe("18:00");
    expect(effectiveEnd("18:00")).toBe("18:00");
  });

  it("ignores a negative or nonsense overtime figure", () => {
    // Overtime can only ever LENGTHEN the day. A negative would shorten it and
    // start flagging people for leaving on time.
    expect(effectiveEnd("18:00", -60)).toBe("18:00");
    expect(effectiveEnd("18:00", Number.NaN)).toBe("18:00");
  });

  it("stays null when there is no schedule to extend", () => {
    expect(effectiveEnd(null, 120)).toBeNull();
  });

  it("clamps inside the day rather than wrapping past midnight", () => {
    // 18:00 + 10 hours is 04:00 the next day, which this module cannot express.
    // Clamping to 23:59 keeps the comparison meaningful; wrapping would make an
    // 18:30 finish read as eight hours EARLY.
    expect(effectiveEnd("18:00", 600)).toBe("23:59");
  });

  it("silences the prompt for a day whose overtime covers the overrun", () => {
    // The end-to-end version of the rule: 20:00 against an 18:00 finish with
    // two hours approved is not a deviation.
    expect(deviation("out", EIGHT_PM, effectiveEnd("18:00", 120), 5)).toBeNull();
    // …and without the approval, it is.
    expect(deviation("out", EIGHT_PM, effectiveEnd("18:00", 0), 5)?.minutes).toBe(120);
  });
});

describe("correctionTypeFor", () => {
  it("maps each side to its request type", () => {
    expect(correctionTypeFor("in")).toBe("TIME_IN_CORRECTION");
    expect(correctionTypeFor("out")).toBe("TIME_OUT_CORRECTION");
  });

  it("never routes a late clock-out to overtime", () => {
    // Overtime is agreed in advance. Turning a forgotten clock-out into an
    // overtime claim would manufacture entitlement out of forgetfulness.
    const late = deviation("out", EIGHT_PM, "18:00", 5)!;
    expect(correctionTypeFor(late.side)).toBe("TIME_OUT_CORRECTION");
  });
});

describe("describeDeviation", () => {
  it("names the state rather than relying on colour", () => {
    expect(describeDeviation({ side: "in", minutes: 6, scheduled: "09:00" })).toBe("Late in · 6m");
    expect(describeDeviation({ side: "out", minutes: -30, scheduled: "18:00" })).toBe(
      "Out early · 30m",
    );
    expect(describeDeviation({ side: "out", minutes: 120, scheduled: "18:00" })).toBe(
      "Out late · 2h",
    );
  });

  it("reads hours and minutes together past the hour", () => {
    expect(describeDeviation({ side: "in", minutes: 95, scheduled: "09:00" })).toBe(
      "Late in · 1h 35m",
    );
  });
});

describe("describeDeviationLong", () => {
  it("states the recorded time, the gap and the schedule", () => {
    expect(describeDeviationLong({ side: "in", minutes: 6, scheduled: "09:00" }, NINE_OH_SIX)).toBe(
      "You timed in at 09:06, 6 minutes after your 09:00 start.",
    );
  });

  it("says before or after, for a time-out", () => {
    expect(describeDeviationLong({ side: "out", minutes: -30, scheduled: "18:00" }, HALF_FIVE)).toBe(
      "You timed out at 17:30, 30 minutes before your 18:00 finish.",
    );
    expect(describeDeviationLong({ side: "out", minutes: 120, scheduled: "18:00" }, EIGHT_PM)).toBe(
      "You timed out at 20:00, 120 minutes after your 18:00 finish.",
    );
  });

  it("says one minute, not one minutes", () => {
    expect(
      describeDeviationLong({ side: "in", minutes: 1, scheduled: "09:00" }, "2026-08-24T01:01:00Z"),
    ).toBe("You timed in at 09:01, 1 minute after your 09:00 start.");
  });
});

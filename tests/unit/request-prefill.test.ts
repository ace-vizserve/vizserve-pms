import { describe, expect, it } from "vitest";

import { INTERNAL_REQUEST_TYPES, narrowRequestPrefill } from "@/lib/schemas/internal-requests";

/**
 * P7-F — the DTR shortcut's query parameters.
 *
 * The whole point is that a mangled URL opens the ordinary dialog instead of
 * erroring, so almost every case here is a bad input that has to come back as
 * `undefined` rather than as a throw.
 */

describe("narrowRequestPrefill", () => {
  it("passes through a real type and date", () => {
    expect(narrowRequestPrefill({ type: "NO_TIME_IN", date: "2026-08-18" })).toEqual({
      type: "NO_TIME_IN",
      date: "2026-08-18",
      time: undefined,
    });
  });

  it("drops a type that is not one of ours", () => {
    expect(narrowRequestPrefill({ type: "SICK_DAY", date: "2026-08-18" })).toEqual({
      type: undefined,
      date: "2026-08-18",
      time: undefined,
    });
  });

  it("drops a date that is not YYYY-MM-DD", () => {
    for (const date of ["banana", "18/08/2026", "2026-8-18", "2026-08-18T00:00:00Z"]) {
      expect(narrowRequestPrefill({ type: "NO_TIME_OUT", date }).date).toBeUndefined();
    }
  });

  it("keeps the good half when the other half is junk", () => {
    // A half-broken link still saves a step. Discarding both would punish
    // somebody for a typo in the part they did not need.
    expect(narrowRequestPrefill({ type: "NO_TIME_IN", date: "nope" })).toEqual({
      type: "NO_TIME_IN",
      date: undefined,
      time: undefined,
    });
  });

  it("returns nothing at all when neither is present", () => {
    expect(narrowRequestPrefill({})).toEqual({
      type: undefined,
      date: undefined,
      time: undefined,
    });
    expect(narrowRequestPrefill({ type: null, date: null, time: null })).toEqual({
      type: undefined,
      date: undefined,
      time: undefined,
    });
  });

  it("refuses a repeated parameter rather than picking one", () => {
    // Next gives `string[]` when a parameter appears twice. `?type=LEAVE&
    // type=OVERTIME` is not a choice, so honouring the first would be inventing
    // an intent nobody expressed.
    expect(narrowRequestPrefill({ type: ["LEAVE", "OVERTIME"] }).type).toBeUndefined();
    expect(narrowRequestPrefill({ date: ["2026-08-18", "2026-08-19"] }).date).toBeUndefined();
  });

  it("accepts every launch type, so the list cannot drift", () => {
    // Walks the real constant. A type added to INTERNAL_REQUEST_TYPES without a
    // thought for the shortcut fails here rather than silently never prefilling.
    // P7-39: walks the CONSTANT rather than a copy of it. The old version
    // hardcoded five names, so the two new correction types would have been
    // added to the app without this ever noticing they could not be linked to.
    for (const type of INTERNAL_REQUEST_TYPES) {
      expect(narrowRequestPrefill({ type }).type).toBe(type);
    }
  });

  it("passes through a 24-hour HH:MM time", () => {
    // P7-40. The DTR sends the SCHEDULED time so the correction dialog opens
    // saying what the record should have said.
    expect(narrowRequestPrefill({ type: "TIME_IN_CORRECTION", date: "2026-08-24", time: "09:00" })).toEqual(
      { type: "TIME_IN_CORRECTION", date: "2026-08-24", time: "09:00" },
    );
  });

  it("drops a time that is not a 24-hour HH:MM", () => {
    for (const time of ["9:00", "09:00:00", "25:00", "09:60", "9am", "banana", ""]) {
      expect(narrowRequestPrefill({ time }).time).toBeUndefined();
    }
  });

  it("accepts the edges of the clock", () => {
    expect(narrowRequestPrefill({ time: "00:00" }).time).toBe("00:00");
    expect(narrowRequestPrefill({ time: "23:59" }).time).toBe("23:59");
  });

  it("refuses a repeated time parameter, like the others", () => {
    expect(narrowRequestPrefill({ time: ["09:00", "10:00"] }).time).toBeUndefined();
  });

  it("takes a shape-valid but impossible date — the schema catches it, not this", () => {
    // 31 February. This is a URL guard, not a calendar; refusing it here would
    // duplicate a rule that already lives in the schema and the function.
    expect(narrowRequestPrefill({ date: "2026-02-31" }).date).toBe("2026-02-31");
  });
});

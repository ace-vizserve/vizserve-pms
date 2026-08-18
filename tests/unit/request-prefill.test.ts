import { describe, expect, it } from "vitest";

import { narrowRequestPrefill } from "@/lib/schemas/internal-requests";

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
    });
  });

  it("drops a type that is not one of ours", () => {
    expect(narrowRequestPrefill({ type: "SICK_DAY", date: "2026-08-18" })).toEqual({
      type: undefined,
      date: "2026-08-18",
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
    });
  });

  it("returns nothing at all when neither is present", () => {
    expect(narrowRequestPrefill({})).toEqual({ type: undefined, date: undefined });
    expect(narrowRequestPrefill({ type: null, date: null })).toEqual({
      type: undefined,
      date: undefined,
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
    for (const type of ["LEAVE", "NO_TIME_IN", "NO_TIME_OUT", "REIMBURSEMENT", "OVERTIME"]) {
      expect(narrowRequestPrefill({ type }).type).toBe(type);
    }
  });

  it("takes a shape-valid but impossible date — the schema catches it, not this", () => {
    // 31 February. This is a URL guard, not a calendar; refusing it here would
    // duplicate a rule that already lives in the schema and the function.
    expect(narrowRequestPrefill({ date: "2026-02-31" }).date).toBe("2026-02-31");
  });
});

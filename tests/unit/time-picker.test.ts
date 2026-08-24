import { describe, expect, it } from "vitest";

import { joinClock, splitClock } from "@/components/ui/time-picker";

/**
 * The 12-hour display over a 24-hour value.
 *
 * Worth testing properly rather than eyeballing, because both ends of the clock
 * are off-by-one traps that look right in the middle of the day: a naive
 * `hour % 12` renders midnight as "0:00 AM" and noon as "0:00 PM", and a naive
 * `+12` on the way back turns 12 AM into 12:00 rather than 00:00. Every one of
 * those writes a real, wrong time into somebody's DTR or timesheet.
 */

describe("splitClock", () => {
  it("reads an ordinary morning and afternoon", () => {
    expect(splitClock("09:06")).toEqual({ hour12: 9, minute: 6, meridiem: "AM" });
    expect(splitClock("18:00")).toEqual({ hour12: 6, minute: 0, meridiem: "PM" });
  });

  it("handles midnight and noon", () => {
    // The two the `% 12 || 12` exists for.
    expect(splitClock("00:00")).toEqual({ hour12: 12, minute: 0, meridiem: "AM" });
    expect(splitClock("12:00")).toEqual({ hour12: 12, minute: 0, meridiem: "PM" });
    expect(splitClock("00:30")).toEqual({ hour12: 12, minute: 30, meridiem: "AM" });
    expect(splitClock("12:30")).toEqual({ hour12: 12, minute: 30, meridiem: "PM" });
  });

  it("trims the seconds Postgres adds", () => {
    // A `time` column comes back as HH:MM:SS; the seconds are not ours to show.
    expect(splitClock("09:00:00")).toEqual({ hour12: 9, minute: 0, meridiem: "AM" });
  });

  it("reads empty as empty rather than as midnight", () => {
    // The whole reason the field can be optional. Treating "" as 00:00 would
    // silently give a schedule to everybody who has none.
    expect(splitClock(null)).toBeNull();
    expect(splitClock(undefined)).toBeNull();
    expect(splitClock("")).toBeNull();
  });

  it("refuses anything that is not a 24-hour clock time", () => {
    for (const bad of ["24:00", "9:00", "09:60", "banana", "7 PM", "0900"]) {
      expect(splitClock(bad)).toBeNull();
    }
  });
});

describe("joinClock", () => {
  it("round-trips every minute of the day", () => {
    // The only assertion that actually proves the pair is lossless. 1440
    // iterations, no wall clock, no timezone.
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        const parts = splitClock(value);
        expect(parts, value).not.toBeNull();
        expect(joinClock(parts!.hour12, parts!.minute, parts!.meridiem), value).toBe(value);
      }
    }
  });

  it("puts midnight at 00 and noon at 12", () => {
    expect(joinClock(12, 0, "AM")).toBe("00:00");
    expect(joinClock(12, 0, "PM")).toBe("12:00");
  });

  it("pads a single digit on both sides", () => {
    expect(joinClock(9, 5, "AM")).toBe("09:05");
  });

  it("keeps every PM hour below 24", () => {
    expect(joinClock(11, 59, "PM")).toBe("23:59");
  });

  it("emits what the schemas accept", () => {
    // `timeOfDay` in lib/schemas/internal-requests.ts, restated. If this ever
    // stops matching, corrections start failing at the server with a regex
    // message and the field will look fine.
    const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (let hour = 1; hour <= 12; hour++) {
      for (const meridiem of ["AM", "PM"] as const) {
        expect(joinClock(hour, 30, meridiem)).toMatch(timeOfDay);
      }
    }
  });
});

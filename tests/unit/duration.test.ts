import { describe, expect, it } from "vitest";

import {
  MAX_SLA_MINUTES,
  SLA_MINUTES_PER_DAY,
  formatSlaDuration,
  parseSlaDuration,
} from "@/lib/schemas/duration";
import { parseCellDuration } from "@/lib/schemas/timesheet";

/**
 * The SLA field's grammar — `5d`, `8h`, `2d 4h`.
 *
 * The last block is the one that matters. This parser and the timesheet's
 * disagree about what a bare number means, and that is deliberate; the test
 * exists so nobody reconciles them without first reading why.
 */

describe("parseSlaDuration", () => {
  it("reads a bare number as DAYS", () => {
    // The field said "SLA (days)" for a year. People type 5 meaning five days.
    expect(parseSlaDuration("5")).toBe(5 * SLA_MINUTES_PER_DAY);
    expect(parseSlaDuration("1")).toBe(480);
    expect(parseSlaDuration("0.5")).toBe(240);
  });

  it("reads each unit", () => {
    expect(parseSlaDuration("5d")).toBe(2400);
    expect(parseSlaDuration("8h")).toBe(480);
    expect(parseSlaDuration("90m")).toBe(90);
  });

  it("adds units together", () => {
    expect(parseSlaDuration("2d 4h")).toBe(2 * 480 + 4 * 60);
    expect(parseSlaDuration("1d 2h 30m")).toBe(480 + 120 + 30);
  });

  it("accepts the sensible spellings", () => {
    expect(parseSlaDuration("5 days")).toBe(2400);
    expect(parseSlaDuration("1 day")).toBe(480);
    expect(parseSlaDuration("8 hours")).toBe(480);
    expect(parseSlaDuration("8 hrs")).toBe(480);
    expect(parseSlaDuration("30 minutes")).toBe(30);
    expect(parseSlaDuration("30 mins")).toBe(30);
  });

  it("is case and whitespace insensitive", () => {
    expect(parseSlaDuration("  2D 4H  ")).toBe(2 * 480 + 4 * 60);
    expect(parseSlaDuration("2d4h")).toBe(2 * 480 + 4 * 60);
  });

  it("refuses the colon form rather than guessing", () => {
    // Same reasoning as the timesheet: 2:30 reads as a clock to half the team.
    expect(parseSlaDuration("2:30")).toBeNull();
  });

  it("refuses a number with no unit alongside other units", () => {
    // `2d 4` is hours to one reader and minutes to another, and the gap is 60x.
    // The timesheet resolves this to minutes; here there is no honest default.
    expect(parseSlaDuration("2d 4")).toBeNull();
    expect(parseSlaDuration("1h30")).toBeNull();
  });

  it("refuses anything it cannot consume whole", () => {
    expect(parseSlaDuration("")).toBeNull();
    expect(parseSlaDuration("   ")).toBeNull();
    expect(parseSlaDuration("soon")).toBeNull();
    expect(parseSlaDuration("5d banana")).toBeNull();
    expect(parseSlaDuration("5 weeks")).toBeNull();
    expect(parseSlaDuration("30s")).toBeNull();
  });

  it("holds the bounds", () => {
    expect(parseSlaDuration("0")).toBeNull();
    expect(parseSlaDuration("0m")).toBeNull();
    expect(parseSlaDuration("1m")).toBe(1);
    expect(parseSlaDuration("365d")).toBe(MAX_SLA_MINUTES);
    expect(parseSlaDuration("366d")).toBeNull();
  });
});

describe("formatSlaDuration", () => {
  it("writes the largest unit first and drops empty ones", () => {
    expect(formatSlaDuration(2400)).toBe("5d");
    expect(formatSlaDuration(480)).toBe("1d");
    expect(formatSlaDuration(1200)).toBe("2d 4h");
    expect(formatSlaDuration(60)).toBe("1h");
    expect(formatSlaDuration(30)).toBe("30m");
    expect(formatSlaDuration(630)).toBe("1d 2h 30m");
  });

  it("round-trips through the parser", () => {
    // What the field renders after a save is exactly what could be typed in.
    for (const minutes of [1, 30, 60, 90, 480, 630, 1200, 2400, MAX_SLA_MINUTES]) {
      expect(parseSlaDuration(formatSlaDuration(minutes))).toBe(minutes);
    }
  });
});

describe("unit-divergence", () => {
  /**
   * DO NOT RECONCILE THESE. A timesheet cell holds part of one working day, so
   * a bare number there is hours. An SLA is a turnaround standard measured in
   * days, and reading `5` as five hours would cut every existing SLA to an
   * eighth of itself. Both readings are correct in their own field.
   */
  it("reads a bare number differently from the timesheet, on purpose", () => {
    expect(parseCellDuration("5")).toBe(5 * 60);
    expect(parseSlaDuration("5")).toBe(5 * SLA_MINUTES_PER_DAY);
  });

  it("differs on which units exist", () => {
    // The timesheet has seconds and no days; the SLA has days and no seconds.
    expect(parseCellDuration("30s")).toBe(1);
    expect(parseSlaDuration("30s")).toBeNull();

    expect(parseCellDuration("5d")).toBeNull();
    expect(parseSlaDuration("5d")).toBe(2400);
  });

  it("agrees where both accept the same string", () => {
    // h and m mean the same thing in both, which is the point of reusing them.
    expect(parseCellDuration("2h 30m")).toBe(150);
    expect(parseSlaDuration("2h 30m")).toBe(150);
  });
});

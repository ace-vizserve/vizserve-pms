import { describe as suite, expect, it } from "vitest";

import { describe } from "@/components/ui/character-count";

/**
 * P11-02 — the wording of the count, tested without a DOM.
 *
 * The component is a paragraph; this is the decision behind it, which is the
 * part with rules in it: when to speak at all, and whether to state a
 * requirement, a shortfall or an overage.
 */
suite("character count", () => {
  it("states the requirement on an empty field, not a shortfall", () => {
    // "10 more characters" on an empty box reads as though something was
    // already counted toward it.
    expect(describe(0, 10, 2000)).toEqual({ text: "At least 10 characters", tone: "neutral" });
  });

  it("counts down once there is something to count from", () => {
    expect(describe(4, 10, 2000)?.text).toBe("6 more characters");
  });

  it("does not say '1 characters'", () => {
    expect(describe(9, 10, 2000)?.text).toBe("1 more character");
  });

  it("goes quiet the moment the floor is met", () => {
    expect(describe(10, 10, 2000)).toBeNull();
  });

  it("stays quiet through the whole middle of the range", () => {
    expect(describe(500, 10, 2000)).toBeNull();
    expect(describe(1_799, 10, 2000)).toBeNull();
  });

  it("speaks again within a tenth of the cap", () => {
    expect(describe(1_800, 10, 2000)).toEqual({ text: "1,800 / 2,000", tone: "warning" });
  });

  it("reports the overage rather than the total", () => {
    // "2,041 / 2,000" makes a reader do the subtraction. What they need is how
    // much to cut.
    expect(describe(2_041, 10, 2000)).toEqual({ text: "41 over the limit", tone: "over" });
  });

  it("says nothing at all on a field with no floor and no cap", () => {
    expect(describe(0, 0, undefined)).toBeNull();
    expect(describe(9_999, 0, undefined)).toBeNull();
  });

  it("handles a floor with no cap — the public approval form", () => {
    expect(describe(0, 10, undefined)?.text).toBe("At least 10 characters");
    expect(describe(50, 10, undefined)).toBeNull();
  });
});

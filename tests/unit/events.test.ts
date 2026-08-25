import { describe, expect, it } from "vitest";

import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  EVENT_CATEGORY_TONE,
  createEventSchema,
  eventScopeLabel,
  updateEventSchema,
} from "@/lib/schemas/events";

/**
 * P7-46 — calendar events.
 *
 * The rule worth guarding hardest is the one the type system cannot state: a
 * DEPARTMENT event must carry a department and the other two must not. Get it
 * wrong in the permissive direction and the calendar paints an event as
 * company-wide while filing it under a team.
 */

const DEPT = "a1000000-0000-4000-8000-000000000001";

function event(overrides: Record<string, unknown> = {}) {
  return {
    title: "Year-end party",
    description: null,
    category: "COMPANY",
    department_id: null,
    start_date: "2026-12-19",
    end_date: "2026-12-19",
    ...overrides,
  };
}

describe("createEventSchema", () => {
  it("takes a one-day company event", () => {
    const parsed = createEventSchema.parse(event());
    expect(parsed.category).toBe("COMPANY");
    expect(parsed.department_id).toBeNull();
  });

  it("takes a multi-day event", () => {
    expect(
      createEventSchema.parse(event({ start_date: "2026-12-19", end_date: "2026-12-21" })).end_date,
    ).toBe("2026-12-21");
  });

  it("refuses an event that ends before it starts", () => {
    expect(
      createEventSchema.safeParse(event({ start_date: "2026-12-21", end_date: "2026-12-19" }))
        .success,
    ).toBe(false);
  });

  it("allows start === end, which is how a one-day event is expressed", () => {
    // The rule is >= and not >. A one-day event is the common case, so getting
    // this backwards would refuse almost every event anybody files.
    expect(
      createEventSchema.safeParse(event({ start_date: "2026-12-19", end_date: "2026-12-19" }))
        .success,
    ).toBe(true);
  });

  it("requires a department on a DEPARTMENT event", () => {
    expect(
      createEventSchema.safeParse(event({ category: "DEPARTMENT", department_id: null })).success,
    ).toBe(false);
    expect(
      createEventSchema.safeParse(event({ category: "DEPARTMENT", department_id: DEPT })).success,
    ).toBe(true);
  });

  it("refuses a department on COMPANY and MANAGEMENT", () => {
    // The stale-form case: the admin picked a department, then switched the
    // category. The client drops it and the server coerces it away, and this is
    // the wall behind both.
    for (const category of ["COMPANY", "MANAGEMENT"]) {
      expect(createEventSchema.safeParse(event({ category, department_id: DEPT })).success).toBe(
        false,
      );
    }
  });

  it("reads a cleared description as null rather than an empty string", () => {
    expect(createEventSchema.parse(event({ description: "" })).description).toBeNull();
    expect(createEventSchema.parse(event({ description: "  " })).description).toBeNull();
  });

  it("refuses a blank title and one too long for a cell", () => {
    expect(createEventSchema.safeParse(event({ title: "   " })).success).toBe(false);
    expect(createEventSchema.safeParse(event({ title: "x".repeat(81) })).success).toBe(false);
  });

  it("refuses a date that does not exist", () => {
    // Inherited from the holiday date rule rather than restated — same format,
    // same bounds, one implementation.
    expect(createEventSchema.safeParse(event({ start_date: "2026-02-31" })).success).toBe(false);
  });
});

describe("updateEventSchema", () => {
  it("needs an id and keeps every create rule", () => {
    expect(createEventSchema.safeParse(event()).success).toBe(true);
    expect(updateEventSchema.safeParse(event()).success).toBe(false);
    expect(
      updateEventSchema.safeParse({ ...event(), id: "b1000000-0000-4000-8000-000000000001" })
        .success,
    ).toBe(true);
  });
});

describe("eventScopeLabel", () => {
  it("names the department for a department event", () => {
    // "Department" tells a reader nothing the team name does not tell them
    // better, which is the whole reason this function exists.
    expect(eventScopeLabel("DEPARTMENT", "VizMedia")).toBe("VizMedia");
  });

  it("falls back when the department did not come along", () => {
    expect(eventScopeLabel("DEPARTMENT", null)).toBe("A department");
  });

  it("uses the category label for the other two", () => {
    expect(eventScopeLabel("COMPANY", null)).toBe("Company-wide");
    expect(eventScopeLabel("MANAGEMENT", "VizMedia")).toBe("Management");
  });
});

describe("the category constants", () => {
  it("covers every category, so none can render unlabelled or uncoloured", () => {
    // The calendar legend, the admin pills and the cell tint all read these.
    // A category present in the enum and missing from either map would paint a
    // blank swatch — the same class of bug an empty request-type pill was.
    for (const category of EVENT_CATEGORIES) {
      expect(EVENT_CATEGORY_LABELS[category].label).toBeTruthy();
      expect(EVENT_CATEGORY_LABELS[category].hint).toBeTruthy();
      expect(EVENT_CATEGORY_TONE[category].text).toBeTruthy();
      expect(EVENT_CATEGORY_TONE[category].swatch).toBeTruthy();
    }
  });

  it("gives each category its own tint", () => {
    // Two categories sharing a colour is worse than no colour: the eye groups
    // them and the label is then contradicting what the tint just said.
    const texts = EVENT_CATEGORIES.map((c) => EVENT_CATEGORY_TONE[c].text);
    expect(new Set(texts).size).toBe(EVENT_CATEGORIES.length);
  });

  it("uses none of the tints the calendar had already spent", () => {
    // info = approved leave, warning = your pending leave, success = holiday,
    // accent = today. An event borrowing one would read as one of them.
    const taken = ["info", "warning", "success", "accent"];
    for (const category of EVENT_CATEGORIES) {
      const tone = EVENT_CATEGORY_TONE[category];
      for (const spent of taken) {
        expect(tone.text).not.toContain(spent);
        expect(tone.surface).not.toContain(spent);
      }
    }
  });
});

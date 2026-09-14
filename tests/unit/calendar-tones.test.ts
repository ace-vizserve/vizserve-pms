import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CALENDAR_FILTER_KINDS,
  CALENDAR_TONES,
  CALENDAR_NEUTRAL_SURFACE,
  CALENDAR_OUTSIDE_SURFACE,
} from "@/app/_home/calendar-tones";
import { EVENT_CATEGORIES, EVENT_CATEGORY_TONE } from "@/lib/schemas/events";

/**
 * P7-35c — the guard the filter needs, because half of it is in a CSS file.
 *
 * `app/globals.css` matches a cell's `data-day-kinds` against the wrapper's
 * `data-calendar-filter` with ONE LITERAL RULE PER KIND, since CSS cannot
 * compare an attribute on one element against an attribute on an ancestor. That
 * is a list of strings in a stylesheet that has to agree with a list of strings
 * in a TypeScript file, and nothing in the compiler can see the relationship.
 *
 * The failure it prevents is a quiet one: an eighth kind added to
 * `CALENDAR_FILTER_KINDS` would appear in the legend, count its dates correctly,
 * respond to a click — and dim nothing, because no rule names it. There is no
 * error, no warning, and no visible difference from a filter that simply found
 * no matches.
 */

const globalsCss = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

describe("calendar filter kinds", () => {
  it("every kind has a rule in globals.css that lights its own cells", () => {
    const missing = CALENDAR_FILTER_KINDS.filter(
      (kind) =>
        !globalsCss.includes(`[data-calendar-filter="${kind}"] [data-day-kinds~="${kind}"]`),
    );

    expect(missing).toEqual([]);
  });

  it("the base fade selects every cell, not only the ones with a kind", () => {
    // The companion to the rule above, and the one that made an empty Wednesday
    // stay lit while the rest of the month faded. It only works because the grid
    // emits `data-day-kinds=""` rather than dropping the attribute.
    expect(globalsCss).toContain("[data-calendar-filter] [data-day-kinds] {");
  });

  it("every kind has a tone", () => {
    for (const kind of CALENDAR_FILTER_KINDS) {
      expect(CALENDAR_TONES[kind]).toBeDefined();
      expect(CALENDAR_TONES[kind].kind).toBe(kind);
      expect(CALENDAR_TONES[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("carries one event kind per category, and no more", () => {
    // Derived from `EVENT_CATEGORIES` rather than retyped, so a fourth category
    // reaches the legend and the filter the day it reaches the enum.
    const eventKinds = CALENDAR_FILTER_KINDS.filter((kind) => kind.startsWith("event-"));

    expect(eventKinds).toEqual(EVENT_CATEGORIES.map((category) => `event-${category}`));
  });

  it("reads the event classes whole instead of assembling them", () => {
    /*
     * Tailwind v4 finds classes by SCANNING SOURCE for literals, so a class
     * built as `text.replace("text-", "bg-")` is never generated and paints
     * nothing. This asserts the tone map hands back exactly what
     * `EVENT_CATEGORY_TONE` holds — the place those literals are written.
     */
    for (const category of EVENT_CATEGORIES) {
      const tone = CALENDAR_TONES[`event-${category}`];

      expect(tone.swatch).toBe(EVENT_CATEGORY_TONE[category].calendarSwatch);
      expect(tone.surface).toBe(EVENT_CATEGORY_TONE[category].calendarSurface);
    }
  });

  it("gives every cell a 4px left bar, including the ones with no colour", () => {
    /*
     * Geometry, not decoration. A bar on some cells and a hairline on others
     * makes the grid's columns disagree by three pixels, which reads as a broken
     * table long before it reads as a missing colour.
     */
    for (const kind of CALENDAR_FILTER_KINDS) {
      expect(CALENDAR_TONES[kind].surface).toContain("border-l-4");
    }

    expect(CALENDAR_NEUTRAL_SURFACE).toContain("border-l-4");
    expect(CALENDAR_OUTSIDE_SURFACE).toContain("border-l-4");
  });
});

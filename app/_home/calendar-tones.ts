import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  EVENT_CATEGORY_TONE,
  type EventCategory,
} from "@/lib/schemas/events";

/**
 * P7-35c — what a calendar cell can BE, named once.
 *
 * The home calendar paints seven different facts into 42 cells, and until now
 * each one's colour was written inline in the cell's `cn()` cascade and again in
 * the legend beneath it. That was survivable while the legend was decoration.
 * It stopped being survivable when the legend became a FILTER: a swatch that
 * dims every cell it does not match has to agree with those cells about what
 * "holiday" means, and two hand-written copies of a colour eight lines apart is
 * exactly the drift the design system's §7 calls out by name.
 *
 * So a kind is declared once, here, with its label, its swatch and the classes
 * its cell wears. The grid reads this map, the legend reads this map, and the
 * filter matches on the `kind` string that both of them got from it.
 *
 * ⚠️ THE `dim` CSS LIVES IN `app/globals.css`, because a CSS attribute selector
 * cannot compare the wrapper's active filter against a cell's own list of kinds
 * — it needs one literal rule per kind. `tests/unit/calendar-tones.test.ts`
 * asserts that block names every kind in `CALENDAR_FILTER_KINDS`, so adding an
 * eighth kind here fails a test rather than shipping a filter that silently
 * dims nothing.
 */

/**
 * Every filterable kind, in the order the legend lists them.
 *
 * The event kinds are derived from `EVENT_CATEGORIES` rather than retyped, so a
 * fourth category appears in the legend and in the filter the day it is added to
 * the enum — the same rule the old legend already followed.
 */
export const CALENDAR_FILTER_KINDS = [
  "approved",
  "pending",
  "holiday",
  ...EVENT_CATEGORIES.map((category) => `event-${category}` as const),
  "today",
] as const;

export type CalendarFilterKind = (typeof CALENDAR_FILTER_KINDS)[number];

/**
 * How a cell of this kind is painted, and how its legend swatch looks.
 *
 * `surface` is what the cell wears when this kind WINS the priority cascade in
 * `leave-calendar.tsx` — a cell that is both a holiday and somebody's leave is
 * painted once, not twice.
 *
 * THE STRENGTH IS IN THE BAR AND THE BORDER, NOT THE FILL, and that is a
 * contrast constraint rather than a taste one. The cell prints its date and the
 * holiday's name in the solid tone on top of the fill, so the fill can only go
 * as dark as 4.5:1 allows — measured, `--success` on a 12% wash of itself is
 * 4.56:1 and a 18% wash is 4.20:1, which fails. The `-subtle` tokens already sit
 * at that ceiling. A 4px bar of the FULL-strength tone carries none of that
 * text, so it is bound only by the 3:1 that a UI boundary owes, and it is what
 * actually makes the calendar readable at a glance.
 */
export type CalendarTone = {
  kind: CalendarFilterKind;
  label: string;
  /** The legend key. Solid, because a 10px wash of a tint reads as nothing. */
  swatch: string;
  /** The cell, when this kind wins. */
  surface: string;
  /** The date, and any name the cell prints in this tone. */
  text: string;
};

/**
 * EVERY CELL CARRIES `border-l-4`, including the empty ones, which is why the
 * neutral entry below sets `border-l-border` rather than leaving it off. A bar
 * on some cells and a hairline on others makes the grid's columns disagree by
 * three pixels, and the eye reads that as a broken table long before it reads it
 * as a missing colour.
 */
export const CALENDAR_NEUTRAL_SURFACE = "border-border border-l-4 border-l-border bg-muted/50";
export const CALENDAR_OUTSIDE_SURFACE =
  "border-border/60 border-l-4 border-l-border/60 bg-muted/40";

const LEAVE_AND_HOLIDAY_TONES: Record<"approved" | "pending" | "holiday" | "today", CalendarTone> = {
  approved: {
    kind: "approved",
    label: "Approved leave",
    swatch: "bg-info border-info",
    surface: "border-info/45 border-l-4 border-l-info bg-info-subtle",
    text: "text-info",
  },
  pending: {
    kind: "pending",
    label: "Your pending leave",
    swatch: "bg-warning border-warning",
    surface: "border-warning/45 border-l-4 border-l-warning bg-warning-subtle",
    text: "text-warning",
  },
  holiday: {
    kind: "holiday",
    label: "Holiday",
    swatch: "bg-success border-success",
    surface: "border-success/45 border-l-4 border-l-success bg-success-subtle",
    text: "text-success",
  },
  /*
   * Today is the brand tone, not a status one, and it stays that way. It is the
   * answer to "where am I" rather than a fact about the day, which is why it
   * outranks every other kind in the cascade and why it borrows `--primary`
   * instead of spending one of the four semantic colours.
   */
  today: {
    kind: "today",
    label: "Today",
    swatch: "bg-primary border-primary",
    surface: "border-primary/45 border-l-4 border-l-primary bg-accent",
    text: "text-accent-foreground",
  },
};

/**
 * Every tone, keyed by kind.
 *
 * The event entries reuse `EVENT_CATEGORY_TONE` — the admin events screen and
 * the event pills already render from it, and a second copy of those three
 * colours is one of the duplications §7 lists. Only the SWATCH is restated, and
 * only because the legend's swatches are solid now while the pills' are washed.
 */
export const CALENDAR_TONES: Record<CalendarFilterKind, CalendarTone> = {
  ...LEAVE_AND_HOLIDAY_TONES,
  ...(Object.fromEntries(
    EVENT_CATEGORIES.map((category: EventCategory) => [
      `event-${category}`,
      {
        kind: `event-${category}`,
        label: EVENT_CATEGORY_LABELS[category].label,
        // Read whole, never assembled. `EVENT_CATEGORY_TONE` holds these as
        // literals precisely so Tailwind's scanner can find them — see the note
        // on that map. Building `bg-event-${category}` here would type-check and
        // render an unstyled box.
        swatch: EVENT_CATEGORY_TONE[category].calendarSwatch,
        surface: EVENT_CATEGORY_TONE[category].calendarSurface,
        text: EVENT_CATEGORY_TONE[category].text,
      },
    ]),
  ) as Record<`event-${EventCategory}`, CalendarTone>),
};

/** One date a filter matched, as the legend prints it back. */
export type CalendarMatch = { date: string; label: string };

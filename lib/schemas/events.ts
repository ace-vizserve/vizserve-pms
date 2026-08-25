import { z } from "zod";

import { holidayDateSchema } from "@/lib/schemas/holidays";

/**
 * P7-46 CONTRACT — calendar events.
 *
 * NOT HOLIDAYS. `vizserve_pms_holidays` says "nobody is scheduled to work" and
 * two database functions read it to decide how many working days a leave
 * request consumes and when a client deadline falls. An event says "this is
 * happening" and people are working through it. Nothing in this file touches
 * working-day arithmetic, and the migration says the same thing louder.
 */

export const EVENT_CATEGORIES = ["COMPANY", "MANAGEMENT", "DEPARTMENT"] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/**
 * How each category reads, and what it means.
 *
 * The hint is not decoration: "Management" and "Company-wide" are both things a
 * whole-company calendar might show, and an admin choosing between them wants
 * to know which one puts it in front of everybody as *their* business.
 */
export const EVENT_CATEGORY_LABELS: Record<EventCategory, { label: string; hint: string }> = {
  COMPANY: {
    label: "Company-wide",
    hint: "Everybody is involved — a town hall, the Christmas party, a shutdown week.",
  },
  MANAGEMENT: {
    label: "Management",
    hint: "Leads and above. Still shown to everyone, so people know why the leads are busy.",
  },
  DEPARTMENT: {
    label: "Department",
    hint: "One team's event. Visible to the whole company, which is how colleagues know who is tied up.",
  },
};

/**
 * The colour each category paints on the calendar.
 *
 * TOKENS, NOT HEX. The three families live in `app/globals.css` with light and
 * dark values, because the calendar had already spent every semantic colour it
 * has — `info` is approved leave, `warning` is your own pending leave, `success`
 * is a holiday, `accent` is today — and reusing one would make an event read as
 * one of those at a glance.
 *
 * Colour is never the only carrier: every event renders its title in the cell,
 * and the calendar legend names each category.
 */
export const EVENT_CATEGORY_TONE: Record<
  EventCategory,
  { text: string; surface: string; border: string; swatch: string }
> = {
  COMPANY: {
    text: "text-event-company",
    surface: "bg-event-company-subtle",
    border: "border-event-company-border",
    swatch: "bg-event-company-subtle border-event-company-border",
  },
  MANAGEMENT: {
    text: "text-event-management",
    surface: "bg-event-management-subtle",
    border: "border-event-management-border",
    swatch: "bg-event-management-subtle border-event-management-border",
  },
  DEPARTMENT: {
    text: "text-event-department",
    surface: "bg-event-department-subtle",
    border: "border-event-department-border",
    swatch: "bg-event-department-subtle border-event-department-border",
  },
};

export const eventCategorySchema = z.enum(EVENT_CATEGORIES, {
  message: "Choose a category.",
});

/**
 * Reuses the holiday date rule rather than restating it.
 *
 * Same format, same bounds, same reason: every consumer compares these as
 * STRINGS — the calendar decides which cell a span lands in with
 * `start <= day && end >= day`, which only works while `YYYY-MM-DD` sorts
 * lexicographically. Two copies of that rule would drift.
 */
const eventDateSchema = holidayDateSchema;

const baseEventSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Give the event a name.")
    .max(80, "Keep it under 80 characters — it has to fit a calendar cell."),
  /**
   * A cleared textarea means "no description", and that has to become NULL.
   *
   * ⚠️ NOT `.or(z.literal(""))`, which is what this was and which never fired.
   * `.trim()` turns "  " into "" and `.max(500)` happily accepts it, so the
   * first branch of the union always matched and the empty-string branch was
   * dead code — every cleared description was stored as "" instead of NULL.
   * Two ways to say "nothing" in one column is how a `description ?? fallback`
   * somewhere downstream renders an empty line instead of the fallback.
   *
   * The transform runs AFTER the length check, so it converts rather than
   * competing with it. (`workClockSchema` in schemas/users.ts gets away with
   * the `.or` form only because its regex rejects "", so the second branch is
   * genuinely reachable there.)
   */
  description: z
    .string()
    .trim()
    .max(500, "Keep the description under 500 characters.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .default(null),
  category: eventCategorySchema,
  department_id: z.uuid().nullable().default(null),
  start_date: eventDateSchema,
  end_date: eventDateSchema,
});

/**
 * The two cross-field rules, checked here as sentences and in the database as
 * constraints. This layer is what an admin reads; that one is what is true.
 */
function withEventRules<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema
    .refine(
      (value) => {
        const v = value as { category?: EventCategory; department_id?: string | null };
        // A department event needs a department; the other two must not carry
        // one, or the calendar would colour it as company-wide and file it
        // under a team at the same time.
        return v.category === "DEPARTMENT" ? Boolean(v.department_id) : !v.department_id;
      },
      {
        message: "A department event needs a department, and the other categories cannot have one.",
        path: ["department_id"],
      },
    )
    .refine(
      (value) => {
        const v = value as { start_date?: string; end_date?: string };
        // A single-day event is start === end, so this is >= and not >.
        return !v.start_date || !v.end_date || v.end_date >= v.start_date;
      },
      { message: "The event cannot end before it starts.", path: ["end_date"] },
    );
}

export const createEventSchema = withEventRules(baseEventSchema);
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = withEventRules(baseEventSchema.extend({ id: z.uuid() }));
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const deleteEventSchema = z.object({ id: z.uuid() });

/**
 * `Company-wide`, or `VizMedia` for a department event.
 *
 * What a person actually wants to read on a calendar cell is WHOSE event it is,
 * and for a department event the category word "Department" says nothing the
 * department name does not say better.
 */
export function eventScopeLabel(
  category: EventCategory,
  departmentName: string | null | undefined,
): string {
  if (category === "DEPARTMENT") return departmentName ?? "A department";
  return EVENT_CATEGORY_LABELS[category].label;
}

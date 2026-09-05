import { z } from "zod";

import { genderSchema } from "@/lib/schemas/users";

/**
 * P7-52 — the contract for the leave-types screen.
 *
 * `vizserve_pms_leave_types` has existed since P7-12 with an admin-write policy
 * and NO SCREEN AT ALL: `label`, `sort_order`, `is_active`, `applies_to_gender`
 * and `calendar_visibility` have been SQL-editor-only since. D25 called types
 * "policy data HR will change" — this is what finally lets them.
 *
 * ⚠️ `code` IS NOT EDITABLE AND IS NOT IN THESE SCHEMAS. It is the stable
 * identifier — P7-45 matches on it, the seed data matches on it, and nothing in
 * this app joins on `label` precisely so a rename is safe. Editing a code would
 * silently detach a type from every rule written against it. Renaming is what
 * `label` is for; retiring is what `is_active` is for.
 */

/**
 * NULL means "applies to everyone", which is the default and the common case.
 * A value restricts it, and `vizserve_pms_leave_type_applies_check` enforces
 * that on insert — so this is a filter on the picker AND a rule in the database.
 */
export const appliesToGenderSchema = genderSchema.nullable().default(null);

/**
 * How the type appears on the shared calendar to somebody who is not the
 * requester. The three values are statutory confidence decisions, not taste —
 * see the list in 20260825100000_p7_42_leave_calendar_details.sql.
 */
export const calendarVisibilitySchema = z.enum(["FULL", "LABEL_HIDDEN", "HIDDEN"]);

export const CALENDAR_VISIBILITY_LABELS: Record<
  z.infer<typeof calendarVisibilitySchema>,
  string
> = {
  FULL: "Name, label and dates",
  LABEL_HIDDEN: 'Name and dates — the label reads "On leave"',
  HIDDEN: "Not shown at all — the absence itself is withheld",
};

export const updateLeaveTypeSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, "A label is required.").max(120, "That label is too long."),
  /**
   * Bounded well past what anybody needs, so a typed 999 sorts last rather than
   * being refused, but not unbounded — an accidental paste of a phone number
   * would otherwise become a sort key.
   */
  sort_order: z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Cannot be negative.")
    .max(999, "Keep it under 1000."),
  is_active: z.boolean().default(true),
  applies_to_gender: appliesToGenderSchema,
  calendar_visibility: calendarVisibilitySchema,
  /**
   * P9-01 — does this kind of leave need somebody to cover the work?
   *
   * When true, a request of this type must name 1–3 relievers, give each of
   * them at least one of the requester's open tasks, and carry the turn-over
   * confirmation — and those relievers become approval stage 1, in front of the
   * team leader and the manager.
   *
   * A COLUMN ON THE TYPE rather than a hardcoded test for `VACATION`, for the
   * same reason the list is a table at all (D25): this is policy data. Vacation
   * is the only one seeded true; whether Maternity or Solo Parent joins it is
   * HR's call and should cost them a tick, not a migration.
   */
  requires_reliever: z.boolean().default(false),
});

export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

export const createLeaveTypeSchema = updateLeaveTypeSchema.omit({ id: true }).extend({
  /**
   * Settable ONCE, on create, and immutable thereafter — which is why it lives
   * here and not in the update schema. Upper snake case because every seeded
   * code is, and a list where one entry reads `sick_leave` among `SICK` and
   * `VACATION` invites somebody to match on the wrong shape.
   */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, "A code is required.")
    .max(40, "That code is too long.")
    .regex(/^[A-Z][A-Z0-9_]*$/, "Letters, digits and underscores only, starting with a letter."),
});

export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;

import { z } from "zod";

import { ROLE_ORDER } from "@/lib/auth/roles";

/**
 * P0-04 CONTRACT — user administration.
 *
 * Two shapes, and the difference between them is the whole security story:
 *
 *   createUserSchema  — needs an email, because it provisions an auth identity.
 *   updateUserSchema  — has no email field AT ALL. Email is the identity that
 *                       links Entra SSO and email/password to one profile
 *                       (P0-03). Editing it here would silently detach a person
 *                       from their own login, and the fix would be a support
 *                       ticket. Changing an address is a delete-and-reinvite.
 */

export const roleSchema = z.enum(ROLE_ORDER);

/**
 * P7-32 — gender.
 *
 * THIS IS WHERE "REQUIRED" LIVES, and it is the only place it can. The column
 * is nullable in Postgres because `vizserve_pms_handle_new_auth_user` inserts a
 * profile row the instant an Entra identity signs in and has no gender to
 * supply — a NOT NULL there would surface as "SSO is broken". So the database
 * says "not recorded yet" and this schema says "a human filling this form must
 * choose", which is the requirement anybody actually meant.
 *
 * The consequence is worth stating: an account created before this landed has
 * no value, and the first time an admin opens and saves it they will be made to
 * pick one. That is the backfill — one record at a time, by somebody who knows
 * the answer — rather than a migration guessing from first names.
 */
export const genderSchema = z.enum(["MALE", "FEMALE"], {
  message: "Choose a gender.",
});

export type Gender = z.infer<typeof genderSchema>;

/** How each value reads in the UI. */
export const GENDER_LABELS: Record<Gender, string> = {
  MALE: "Male",
  FEMALE: "Female",
};

/**
 * The managed-department set. Empty is meaningful, not missing: a team_leader
 * with no departments leads nothing and sees nothing, which is the correct
 * state for someone mid-handover.
 */
const managedDepartmentsSchema = z.array(z.uuid()).default([]);

/**
 * P7-36 — the scheduled working day.
 *
 * OPTIONAL, AND THE EMPTY STRING IS HOW A FORM SAYS NULL. An `<input type="time">`
 * that has been cleared submits "", not undefined, so the coercion belongs here
 * rather than in every caller.
 *
 * Both-or-neither is checked on the object below, not on the field, because a
 * field cannot see its partner. The database says the same thing again in
 * `vizserve_pms_users_work_hours_shape` — this layer is the sentence the admin
 * reads, that one is the rule.
 */
const workClockSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time, like 09:00.")
  .nullable()
  .default(null)
  .or(z.literal("").transform(() => null));

/**
 * P8-05 — this person's unpaid break, or the absence of an answer.
 *
 * ⚠️ BLANK IS NULL AND NULL IS NOT ZERO, and that distinction is the entire
 * reason this field is not a plain number.
 *
 *   ""  → null → inherit the company break from /admin/settings
 *   "0" → 0    → this person takes no unpaid break
 *
 * A blank coerced to 0 would silently declare that everybody an admin has ever
 * opened works straight through lunch, and their timesheet week would then have
 * to reach an hour a day more than it should before the database would accept
 * it. So the empty string is caught FIRST, before any coercion can turn it into
 * a number — the same order `timeOfDay` in the timesheet schema uses, and the
 * opposite of `blankToNaN`, which is right for a field where blank is a mistake
 * and wrong for one where blank is an answer.
 *
 * The 0-480 bounds mirror `vizserve_pms_users_break_range`. The database is the
 * rule; this is the sentence an admin reads instead of a constraint name.
 */
const blankToNull = (value: unknown) =>
  value === undefined || (typeof value === "string" && value.trim() === "") ? null : value;

const breakMinutesSchema = z
  .preprocess(
    blankToNull,
    z.coerce
      .number({ message: "Enter a number of minutes, or leave it blank to use the company break." })
      .int("Whole minutes only.")
      .min(0, "That cannot be negative. Zero means no unpaid break.")
      .max(480, "Eight hours is the ceiling. A break longer than a working day leaves nothing to measure.")
      // Outside the coercion, not inside it: `Number(null)` is 0, so a nullable
      // wrapped around a coercion is the only ordering that keeps "unset" from
      // becoming "no break".
      .nullable(),
  )
  .default(null);

/**
 * Both times or neither, and the end after the start.
 *
 * NO OVERNIGHT SCHEDULE. A 22:00–06:00 shift is a real thing that this app does
 * not model yet (Q8, still open) — the DTR's punch path handles an overnight
 * shift fine, but there is nowhere to record that it was SCHEDULED that way, and
 * a 22:00–06:00 pair here would be read as a sixteen-hour day running backwards.
 * Refused with a sentence rather than accepted and misread.
 */
function withWorkHourRules<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema
    .refine(
      (value) =>
        Boolean((value as { work_start?: string | null }).work_start) ===
        Boolean((value as { work_end?: string | null }).work_end),
      {
        message: "Set both a start and an end, or leave both blank for no fixed schedule.",
        path: ["work_end"],
      },
    )
    .refine(
      (value) => {
        const start = (value as { work_start?: string | null }).work_start;
        const end = (value as { work_end?: string | null }).work_end;
        return !start || !end || end > start;
      },
      {
        message: "The end of the day has to be after the start. Overnight schedules are not supported yet.",
        path: ["work_end"],
      },
    );
}

export const createUserSchema = withWorkHourRules(
  z.object({
    email: z.email("Enter a valid email address.").transform((value) => value.trim().toLowerCase()),
    full_name: z.string().trim().min(1, "A full name is required."),
    gender: genderSchema,
    role: roleSchema,
    /**
     * P7-52. The HR job, and NOT a role — see D33. Orthogonal to `role` above,
     * so the two are set independently and neither implies the other.
     *
     * Admin-only to set, enforced in the action rather than here: a schema
     * cannot know who is submitting it, and `/admin/users` is the only screen
     * that carries this field. That is what stops HR appointing more HR.
     */
    is_hr: z.boolean().default(false),
    /**
     * P8-01. Administrative capability over THIS PERSON'S OWN department —
     * `primary_department_id` above, the team they belong to, not one they
     * lead. A tick and NOT a role, for the reason D33 gave for HR: the role
     * enum is a total order and "department admin" sits nowhere on it.
     *
     * Owner-only to set, enforced in the action rather than here — a schema
     * cannot know who is submitting it. That is what stops the tick escalating
     * itself.
     */
    is_dept_admin: z.boolean().default(false),
    primary_department_id: z.uuid().nullable().default(null),
    managed_department_ids: managedDepartmentsSchema,
    work_start: workClockSchema,
    work_end: workClockSchema,
    /** P8-05. Blank means inherit the company break — see the schema above. */
    break_minutes: breakMinutesSchema,
  }),
);

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = withWorkHourRules(
  z.object({
    full_name: z.string().trim().min(1, "A full name is required."),
    /**
     * Required on edit too, not just on create — which is what makes the existing
     * unset accounts fill themselves in. An admin who opens a pre-P7-32 record to
     * change anything at all is asked for this before it saves.
     */
    gender: genderSchema,
    role: roleSchema,
    /**
     * P7-52. The HR job, and NOT a role — see D33. Orthogonal to `role` above,
     * so the two are set independently and neither implies the other.
     *
     * Admin-only to set, enforced in the action rather than here: a schema
     * cannot know who is submitting it, and `/admin/users` is the only screen
     * that carries this field. That is what stops HR appointing more HR.
     */
    is_hr: z.boolean().default(false),
    /**
     * P8-01. Administrative capability over THIS PERSON'S OWN department —
     * `primary_department_id` above, the team they belong to, not one they
     * lead. A tick and NOT a role, for the reason D33 gave for HR: the role
     * enum is a total order and "department admin" sits nowhere on it.
     *
     * Owner-only to set, enforced in the action rather than here — a schema
     * cannot know who is submitting it. That is what stops the tick escalating
     * itself.
     */
    is_dept_admin: z.boolean().default(false),
    primary_department_id: z.uuid().nullable().default(null),
    managed_department_ids: managedDepartmentsSchema,
    is_active: z.boolean().default(true),
    /**
     * Whether this person may enter THIS application.
     *
     * Separate from `is_active` on purpose. Deactivated means "no longer with us";
     * this means "a real, current colleague who works in a different system". The
     * auth pool is shared with other HFSE products and Entra admits the whole
     * tenant, so the two are genuinely different states.
     */
    has_app_access: z.boolean().default(true),
    /**
     * P7-36. Unlike gender, NOT required on edit: plenty of people here work no
     * fixed hours, and forcing a schedule onto every record an admin happens to
     * open would invent a start time for them — which the DTR would then judge
     * their punches against.
     */
    work_start: workClockSchema,
    work_end: workClockSchema,
    /**
     * P8-05. Optional on edit for the same reason the hours are, and one more:
     * the company break is the right answer for almost everybody, so a blank
     * here is the NORMAL state rather than an unfinished record. Filling it in
     * is how somebody departs from the company arrangement, not how they
     * confirm it.
     */
    break_minutes: breakMinutesSchema,
  }),
);

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/**
 * A managed set is only meaningful for team_leader and above — a member holds
 * scope over nothing by definition (D15). Normalising here rather than in the
 * action keeps both tracks agreeing on what gets stored, and stops a stale
 * checkbox from a role switch quietly granting scope.
 */
export function normaliseManagedDepartments(
  role: z.infer<typeof roleSchema>,
  managedDepartmentIds: string[],
): string[] {
  if (role === "member") return [];
  return [...new Set(managedDepartmentIds)];
}

/**
 * How each role reads in the UI. Ordered most-privileged first for a select.
 *
 * ⚠️ `admin` IS A DEAD RUNG AND THE PICKER MUST NOT OFFER IT. P8-01 moved what
 * it meant up to `owner` and promoted every row; the value survives only
 * because dropping it from the Postgres enum would mean rebuilding the type on
 * a live database. It still needs a LABEL — `Record` over the whole union, and
 * a legacy or restored row would otherwise render as a blank cell — but it is
 * excluded from `ROLE_OPTIONS` in the editor, which is what the picker reads.
 * Setting somebody to it would grant them nothing: every predicate now says
 * `>= owner`.
 */
export const ROLE_LABELS: Record<z.infer<typeof roleSchema>, { label: string; hint: string }> = {
  owner: {
    label: "Owner",
    hint: "Everything, every department. Manages users, roles and settings.",
  },
  admin: {
    label: "Admin (retired)",
    hint: "The old name for Owner. Nobody holds it; kept so legacy records still read.",
  },
  manager: {
    label: "Manager",
    hint: "Oversees the departments ticked below. Inherits team leader.",
  },
  team_leader: {
    label: "Team Leader",
    hint: "Approves requests for the departments ticked below.",
  },
  member: {
    label: "Member",
    hint: "Works on tasks assigned to them. No department scope.",
  },
};

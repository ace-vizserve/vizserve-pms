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

export const createUserSchema = z.object({
  email: z.email("Enter a valid email address.").transform((value) => value.trim().toLowerCase()),
  full_name: z.string().trim().min(1, "A full name is required."),
  gender: genderSchema,
  role: roleSchema,
  primary_department_id: z.uuid().nullable().default(null),
  managed_department_ids: managedDepartmentsSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  full_name: z.string().trim().min(1, "A full name is required."),
  /**
   * Required on edit too, not just on create — which is what makes the existing
   * unset accounts fill themselves in. An admin who opens a pre-P7-32 record to
   * change anything at all is asked for this before it saves.
   */
  gender: genderSchema,
  role: roleSchema,
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
});

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

/** How each role reads in the UI. Ordered most-privileged first for a select. */
export const ROLE_LABELS: Record<z.infer<typeof roleSchema>, { label: string; hint: string }> = {
  admin: {
    label: "Admin",
    hint: "Everything, every department. Manages users.",
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

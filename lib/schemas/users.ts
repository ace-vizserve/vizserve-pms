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
 * The managed-department set. Empty is meaningful, not missing: a team_leader
 * with no departments leads nothing and sees nothing, which is the correct
 * state for someone mid-handover.
 */
const managedDepartmentsSchema = z.array(z.uuid()).default([]);

export const createUserSchema = z.object({
  email: z.email("Enter a valid email address.").transform((value) => value.trim().toLowerCase()),
  full_name: z.string().trim().min(1, "A full name is required."),
  role: roleSchema,
  primary_department_id: z.uuid().nullable().default(null),
  managed_department_ids: managedDepartmentsSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  full_name: z.string().trim().min(1, "A full name is required."),
  role: roleSchema,
  primary_department_id: z.uuid().nullable().default(null),
  managed_department_ids: managedDepartmentsSchema,
  is_active: z.boolean().default(true),
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

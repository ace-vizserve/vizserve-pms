import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import type { VizservePmsUserRole } from "@/lib/database.types";

/**
 * P0-05 — the single server-side authorization layer.
 *
 * Every server-side scope decision goes through this module. Not because it is
 * tidier, but because:
 *   1. scattered `if (role === 'admin')` checks drift, and the one that drifts
 *      is never the one you are looking at;
 *   2. it is hedge #1 for deferred multi-tenancy (Q3) — a tenant dimension gets
 *      added here once instead of in a hundred queries.
 *
 * This layer is belt; RLS is braces. Neither is sufficient alone: RLS cannot
 * express "this button is disabled", and this cannot survive someone querying
 * Supabase directly.
 *
 * IT READS `vizserve_pms_users.role`. It does not read `user_metadata`, ever.
 * That field is writable by the user through Supabase's own GoTrue endpoint
 * (docs/02-data-model.md §Auth metadata) — trusting it here would be a silent
 * privilege escalation with no audit trail.
 */

/** Ascending authority. Mirrors the Postgres enum declaration order exactly. */
export const ROLE_ORDER = ["member", "team_leader", "manager", "admin"] as const;

export type Role = VizservePmsUserRole;

/**
 * Roles are INCLUSIVE: admin ⊇ manager ⊇ team_leader ⊇ member (D15).
 * Always `>=`, never `===`. Amier is an admin who is also a TL; an equality
 * check would lock him out of his own approval queue.
 */
export function roleAtLeast(role: Role | null | undefined, required: Role): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}

export type AuthContext = {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  /** The department the user *belongs to*. Not the same as what they lead. */
  primaryDepartmentId: string | null;
  /** The departments they lead or oversee. Empty for a plain member. */
  managedDepartmentIds: string[];
};

export class ForbiddenError extends Error {
  constructor(message = "You do not have access to this resource.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Resolves the caller once per request.
 *
 * `getUser()` rather than `getSession()` — getSession reads the cookie without
 * revalidating it, which is fine for rendering and not fine for a decision.
 *
 * Returns null for: no session, no profile row, or a deactivated profile.
 * Deactivation is a real gate, not a UI flag.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("vizserve_pms_users")
    .select("id, email, full_name, role, primary_department_id, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) return null;

  const { data: managed } = await supabase
    .from("vizserve_pms_user_managed_departments")
    .select("department_id")
    .eq("user_id", user.id);

  return {
    userId: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    primaryDepartmentId: profile.primary_department_id,
    managedDepartmentIds: (managed ?? []).map((row) => row.department_id),
  };
});

/** For pages. Sends anyone without a usable session to the login screen. */
export async function requireAuthContext(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) redirect("/login");
  return context;
}

/** For pages that a role floor guards. */
export async function requireRole(required: Role): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!roleAtLeast(context.role, required)) {
    throw new ForbiddenError(`This action requires the ${required} role or higher.`);
  }
  return context;
}

/**
 * For server actions and route handlers, where redirecting is the wrong shape.
 * Throws rather than returning null so a forgotten check cannot read as "allow".
 */
export async function requireAuthContextOrThrow(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) throw new ForbiddenError("You must be signed in.");
  return context;
}

/**
 * Department scope. An admin reaches everything; everyone else must hold
 * team_leader-or-above AND have this department in their managed set. Holding
 * the role alone is not enough — that is the whole point of the managed-set
 * table (D15).
 */
export function canAccessDepartment(context: AuthContext, departmentId: string | null): boolean {
  if (roleAtLeast(context.role, "admin")) return true;
  if (!departmentId) return false;
  return (
    roleAtLeast(context.role, "team_leader") && context.managedDepartmentIds.includes(departmentId)
  );
}

export function assertDepartmentAccess(context: AuthContext, departmentId: string | null): void {
  if (!canAccessDepartment(context, departmentId)) {
    throw new ForbiddenError("That department is outside your scope.");
  }
}

/**
 * The department filter for list queries.
 *
 * `null` means "no filter — this user sees everything" (admin). An empty array
 * means "this user leads nothing", and callers MUST treat that as zero rows
 * rather than as no filter. Getting that backwards turns a member into an
 * admin, so it is stated here rather than left to each call site.
 */
export function departmentScopeFilter(context: AuthContext): string[] | null {
  if (roleAtLeast(context.role, "admin")) return null;
  if (!roleAtLeast(context.role, "team_leader")) return [];
  return context.managedDepartmentIds;
}

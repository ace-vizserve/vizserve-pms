import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { APP_ACCESS_KEY } from "@/lib/auth/app-access";
import { ROLE_ORDER, roleAtLeast, type Role } from "@/lib/auth/roles";

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

/**
 * The hierarchy itself lives in `lib/auth/roles.ts`, which has no `server-only`
 * import — a role selector and a zod schema need the ordering on the client, and
 * a second copy of the list is how the TS `>=` and the Postgres `>=` drift apart.
 *
 * Re-exported here so that call sites keep importing every authorization concern
 * from one module.
 */
export { ROLE_ORDER, roleAtLeast, type Role };

/** Re-exported so every authorization concern is imported from one module. */
export { APP_ACCESS_KEY };

import type { Gender } from "@/lib/schemas/users";

export type AuthContext = {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  /**
   * P7-45. Decides which leave types this person may file. NULL means it was
   * never recorded, which is a real state — the auth trigger creates profile
   * rows with no gender to supply — and is treated as "offer everything"
   * rather than "offer nothing".
   *
   * NOT AN AUTHORIZATION INPUT, despite living on the auth context. Nothing
   * here grants or withholds access; it narrows a picker. It rides along
   * because the profile row is already being read and a second query for one
   * column on every leave screen would be waste.
   */
  gender: Gender | null;
  /** The department the user *belongs to*. Not the same as what they lead. */
  primaryDepartmentId: string | null;
  /** The departments they lead or oversee. Empty for a plain member. */
  managedDepartmentIds: string[];
};

/**
 * Why a session did not resolve to a usable context.
 *
 * Distinguished because they need different answers on screen: "sign in" is
 * useless advice to someone who IS signed in and simply is not a user of this
 * product, and bouncing them to /login produces a loop.
 */
export type AuthDenial =
  | "no_session"
  /** Signed in, but has no profile row in this application at all. */
  | "not_provisioned"
  /** Has a profile, but it is deactivated. */
  | "deactivated"
  /** Has an active profile, but is not provisioned for THIS application. */
  | "no_app_access";

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
export const resolveAuth = cache(
  async (): Promise<{ context: AuthContext } | { context: null; denial: AuthDenial }> => {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { context: null, denial: "no_session" };

    const { data: profile } = await supabase
      .from("vizserve_pms_users")
      .select(
        "id, email, full_name, gender, role, primary_department_id, is_active, app_access",
      )
      .eq("id", user.id)
      .maybeSingle();

    // A valid session with no profile row. Real and expected: the auth pool is
    // shared with other HFSE systems, and Entra SSO admits the whole tenant.
    if (!profile) return { context: null, denial: "not_provisioned" };

    if (!profile.is_active) return { context: null, denial: "deactivated" };

    // THE APP ACCESS GATE.
    //
    // Read from the TABLE, not from `user.user_metadata.app_access`. The
    // metadata copy exists and says the same thing, and is worthless here: any
    // signed-in user can rewrite it through Supabase's own endpoint with their
    // own token. Trusting it would let anyone locked out let themselves back in
    // with one curl — see tests/db/scope.test.ts, which performs exactly that
    // escalation, and `npm run check:metadata`, which fails the build for
    // reading it in this path (D18).
    //
    // `user.app_metadata` would be trustworthy, but it is a snapshot taken when
    // the token was issued. Revoking access should take effect now, not at the
    // next refresh — so the table wins, and the JWT copy is only for the
    // proxy's cheap redirect.
    if (!(profile.app_access ?? []).includes(APP_ACCESS_KEY)) {
      return { context: null, denial: "no_app_access" };
    }

    const { data: managed } = await supabase
      .from("vizserve_pms_user_managed_departments")
      .select("department_id")
      .eq("user_id", user.id);

    return {
      context: {
        userId: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        gender: profile.gender,
        role: profile.role,
        primaryDepartmentId: profile.primary_department_id,
        managedDepartmentIds: (managed ?? []).map((row) => row.department_id),
      },
    };
  },
);

/** The common case: a context or nothing, without caring which denial applied. */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  return (await resolveAuth()).context;
});

/**
 * For pages. Sends anyone without a usable session somewhere they can act on.
 *
 * The branch matters. Someone who is signed in but not provisioned for this
 * product does not need /login — they are already authenticated, so bouncing
 * them there either loops or silently signs them back in and bounces again.
 * They need to be told, plainly, that this is not their application.
 */
export async function requireAuthContext(): Promise<AuthContext> {
  const result = await resolveAuth();

  if (result.context) return result.context;

  if (result.denial === "no_session") redirect("/login");
  redirect(`/no-access?reason=${result.denial}`);
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

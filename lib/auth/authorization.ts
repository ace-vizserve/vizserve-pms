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
  /**
   * P7-52. Whether this person holds the HR job, which is ORTHOGONAL to `role`
   * and not a rank on it. Read `canDoHr()` rather than this field: an admin is
   * HR without carrying the flag, and every check in the database says so.
   *
   * Unlike `gender` above, this one IS an authorization input.
   */
  isHr: boolean;
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
        "id, email, full_name, gender, role, is_hr, primary_department_id, is_active, app_access",
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
        isHr: profile.is_hr,
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
 * P7-52 — the HR capability, and the ONLY TypeScript definition of it.
 *
 * Mirrors `vizserve_pms_is_hr()` exactly, and the mirroring is the point: that
 * function is what every policy and every SECURITY DEFINER check actually
 * consults, so a second reading of "is this person HR" written inline at a call
 * site is a disagreement waiting to happen.
 *
 * ⚠️ THE ADMIN BRANCH IS LOAD-BEARING, not a courtesy. Admin *is* HR today —
 * `vizserve_pms_leave_balances` says so in a comment (p7_33:262) — so P7-52
 * widened every one of those checks from `is_admin()` to `is_hr()`. Drop the
 * admin branch here and the UI would start hiding screens from admins that the
 * database still lets them use.
 *
 * The active/app-access gates the SQL also applies are already enforced upstream:
 * `resolveAuth` returns no context at all for a deactivated or access-revoked
 * user, so by the time there is an `AuthContext` to pass in, both hold.
 */
export function canDoHr(context: AuthContext): boolean {
  return context.isHr || roleAtLeast(context.role, "admin");
}

/**
 * For pages and actions the HR capability guards.
 *
 * Deliberately NOT `requireRole`-shaped: HR is not a floor on the role ladder,
 * and expressing it as one is the mistake this whole change exists to avoid.
 */
export async function requireHr(): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!canDoHr(context)) {
    throw new ForbiddenError("This area is for HR.");
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

/**
 * P7-66 — the same scope, shaped for a query that is BUILT rather than filtered.
 *
 * ⚠️ THERE IS NO SUCH THING AS A FILTER THAT MATCHES NOTHING, and pretending
 * otherwise is what this exists to stop. `departmentScopeFilter` hands back an
 * empty array for "leads nothing", which a list query passes to RLS and gets
 * zero rows from. But a picker query has no policy doing the work — it selects
 * every active department and narrows with `.in("id", …)` — so the call sites
 * reached for a sentinel, `.in("id", [""])`, and `""` is not a uuid:
 *
 *   invalid input syntax for type uuid: ""   (22P02)
 *
 * That is not a hypothetical. A newly created team leader with no department
 * mapping hits it on every load of /forms/new and /forms/[id], and it was
 * survivable only for as long as the error was being discarded — which stopped
 * being true the moment `departmentsError` was grouped with the reads that must
 * not open the builder. "This person leads nothing" then rendered as a failed
 * page.
 *
 * So the answer is a PLAN, and `none` means DO NOT RUN THE QUERY:
 *
 *   all    every active department (admin)
 *   some   exactly these ids
 *   none   an empty list, with no round trip and therefore no error to confuse
 *          with a real one
 *
 * Kept beside `departmentScopeFilter` and derived from it, so there is still one
 * place that decides what a role reaches (CLAUDE.md) — this only re-states its
 * answer in the terms a picker can act on.
 */
export type DepartmentPickerScope =
  | { kind: "all" }
  | { kind: "some"; ids: string[] }
  | { kind: "none" };

export function departmentPickerScope(context: AuthContext): DepartmentPickerScope {
  const filter = departmentScopeFilter(context);

  if (filter === null) return { kind: "all" };
  if (filter.length === 0) return { kind: "none" };

  return { kind: "some", ids: filter };
}

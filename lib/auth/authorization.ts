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
  /**
   * P8-01. Whether this person holds administrative capability over THEIR OWN
   * department — `primaryDepartmentId`, the team they belong to, not one they
   * lead. ORTHOGONAL to `role` and not a rank on it, exactly as `isHr` is
   * (D33): a member may hold it and still report to their Team Leader.
   *
   * Read `canAdminDepartment()` rather than this field: an owner administers
   * every department without carrying the flag, and `vizserve_pms_is_dept_admin`
   * says so.
   *
   * ⚠️ Confers NO approval rights. `vizserve_pms_manages_department` is
   * deliberately untouched by P8-01 — see the note at the bottom of
   * 20260903100100_p8_01b_admin_capability.sql.
   */
  isDeptAdmin: boolean;
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
 * The profile columns `resolveAuth` needs, WITHOUT `is_dept_admin`.
 *
 * Split out because the read below has to be able to run twice — once asking for
 * the P8-01 column and once not. See `deptAdminColumnMissing`.
 */
const PROFILE_COLUMNS =
  "id, email, full_name, gender, role, is_hr, primary_department_id, is_active, app_access" as const;

/**
 * P8-01 — DOES THIS FAILED READ MEAN "THE COLUMN IS NOT THERE YET"?
 *
 * ⚠️ THIS EXISTS BECAUSE MIGRATIONS IN THIS REPO ARE APPLIED BY HAND, IN THE
 * SUPABASE SQL EDITOR, AFTER THE CODE IS DEPLOYED (CLAUDE.md;
 * docs/13-implementation-status.md). There is therefore a real window in which
 * this file is live and `p8_01b` has not been pasted yet — and in that window a
 * select naming `is_dept_admin` is rejected WHOLE. Not the column: the query.
 * PostgREST returns no row at all, `resolveAuth` sees no profile, and every
 * signed-in person is answered `not_provisioned`.
 *
 * That is a total outage rather than a dead feature, and it locks out the owner
 * who would have pasted the migration — there is no route back in through the
 * app. So the read DEGRADES instead of denying, on the same reasoning as
 * `lib/settings-server.ts`: a capability nobody can hold yet is not worth a
 * whole-app lockout.
 *
 * ⚠️ IT RESTORES THE SESSION, NOT THE RANK, AND THE DIFFERENCE IS THE WHOLE
 * DEPLOY PLAN. Between `p8_01a` and `p8_01b` every account still holds the
 * retired `admin` rung, so `requireRole("owner")` matches NOBODY: /admin/* and
 * /hr/* throw, and `departmentScopeFilter` narrows to what each person leads.
 * People can sign in and work; the admin screens are shut. That is recoverable
 * only from the SQL editor, which is exactly why the two files must be pasted
 * in the same sitting as the deploy rather than at leisure.
 *
 * There is deliberately NO shim treating `admin` as `owner` to close that gap.
 * It would hand owner powers to any legacy or restored `admin` row — the thing
 * `tests/unit/dept-admin-capability.test.ts` asserts cannot happen — and it
 * would outlive the window it was written for.
 *
 * ⚠️ NARROW ON PURPOSE. It is not "the read failed"; it is "the read failed
 * naming THIS column". A genuine no-profile row (`maybeSingle` reports no error
 * for zero rows) and every other failure still fall through to
 * `not_provisioned`, exactly as before. Turning every error into a successful
 * read would be a far worse bug than the one this fixes.
 *
 * Matched on the CODE *and* the column name, because either alone is wrong:
 * a bare 42703 could be about some other column in a future edit of the select,
 * and a message match alone would catch an unrelated error that happened to
 * mention it. Postgres raises 42703 (undefined_column); PostgREST forwards it,
 * and answers PGRST204 when its own schema cache is the stale half.
 *
 * ONCE `p8_01b` IS APPLIED EVERYWHERE, this function and the fallback read below
 * can be deleted and the select folded back into one call.
 */
export function deptAdminColumnMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;

  const message = error.message ?? "";
  if (!message.includes("is_dept_admin")) return false;

  const code = error.code ?? "";
  return code === "42703" || code === "PGRST204" || /does not exist|schema cache/i.test(message);
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

    const attempt = await supabase
      .from("vizserve_pms_users")
      .select(`${PROFILE_COLUMNS}, is_dept_admin`)
      .eq("id", user.id)
      .maybeSingle();

    let profile: (typeof attempt)["data"] = attempt.data;

    // P8-01 — THE DEGRADE. See `deptAdminColumnMissing` above for why this is
    // here rather than a single select: the code ships before the migration is
    // pasted, and denying on an unknown column would lock the whole company out
    // of a live app, owner included.
    //
    // ⚠️ `isDeptAdmin: false` IS THE ONLY ANSWER THIS BRANCH MAY GIVE, and it is
    // the safe one in both directions. It matches the column's own
    // `default false`, so nobody loses anything they actually hold — the column
    // does not exist yet, so nobody holds it — and it cannot GRANT the
    // capability to anyone, because `canAdminDepartment` reads the flag only in
    // its non-owner branch. An owner still administers every department while
    // degraded, which is exactly what the pre-migration database says too:
    // `vizserve_pms_is_dept_admin` is not there either, so no policy consults it.
    if (!profile && deptAdminColumnMissing(attempt.error)) {
      const degraded = await supabase
        .from("vizserve_pms_users")
        .select(PROFILE_COLUMNS)
        .eq("id", user.id)
        .maybeSingle();

      // Still `null` for a genuinely missing row — the fallback re-asks the same
      // question without the new column, it does not invent an answer.
      profile = degraded.data ? { ...degraded.data, is_dept_admin: false } : null;
    }

    // A valid session with no profile row. Real and expected: the auth pool is
    // shared with other HFSE systems, and Entra SSO admits the whole tenant.
    //
    // Also where every OTHER read failure lands, unchanged by the degrade above:
    // an RLS refusal, a network fault, a 42703 about some other column. Denying
    // on those is the old behaviour and stays the right one.
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
        isDeptAdmin: profile.is_dept_admin,
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
 * ⚠️ THE OWNER BRANCH IS LOAD-BEARING, not a courtesy. The top rung *is* HR —
 * `vizserve_pms_leave_balances` says so in a comment (p7_33:262) — so P7-52
 * widened every one of those checks from `is_admin()` to `is_hr()`. Drop the
 * owner branch here and the UI would start hiding screens from owners that the
 * database still lets them use.
 *
 * P8-01 moved it from `"admin"` to `"owner"` on both sides at once. Leaving it
 * at `"admin"` would have kept working by accident — owner outranks admin — but
 * would have disagreed with `vizserve_pms_is_hr()`, which now reads
 * `u.role >= 'owner'`, about a stray legacy `admin` row.
 *
 * The active/app-access gates the SQL also applies are already enforced upstream:
 * `resolveAuth` returns no context at all for a deactivated or access-revoked
 * user, so by the time there is an `AuthContext` to pass in, both hold.
 */
export function canDoHr(context: AuthContext): boolean {
  return context.isHr || roleAtLeast(context.role, "owner");
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
 * P8-01 — the department-admin capability, and the ONLY TypeScript definition
 * of it.
 *
 * Mirrors `vizserve_pms_is_dept_admin(uuid)` EXACTLY, and the mirroring is the
 * point: that function is what any policy consulting this capability will
 * actually evaluate, so a second reading written inline at a call site is a
 * disagreement waiting to happen. Owner, or the flag AND the department being
 * asked about being the holder's own — nothing else, in either language.
 *
 * ⚠️ `primaryDepartmentId`, NOT `managedDepartmentIds`. A department admin is a
 * member of their department BY RANK and does not lead it — they administer the
 * team they are in, still reporting to its Team Leader. Reading the managed set
 * here would turn the tick into a second, invisible way of being a lead.
 *
 * ⚠️ THIS IS NOT APPROVAL AUTHORITY. `canAccessDepartment` and
 * `vizserve_pms_manages_department` are what decide who may approve, and P8-01
 * deliberately left both alone. The Admin tick confers administrative
 * capability and no approval rights whatsoever.
 *
 * ⚠️ THE OWNER BRANCH IS LOAD-BEARING for the same reason `canDoHr`'s is:
 * without it, ticking somebody as a department admin would read as taking that
 * department away from the owner.
 *
 * The active/app-access gates the SQL also applies are already enforced
 * upstream: `resolveAuth` returns no context at all for a deactivated or
 * access-revoked user, so by the time there is an `AuthContext` to pass in, both
 * hold.
 *
 * A null `departmentId` — a person with no department, or a row that has not
 * been assigned one — is false for everyone but an owner, which is the correct
 * reading of "administers no department". It matches the SQL, where the `=`
 * against null is null and therefore not true.
 */
export function canAdminDepartment(context: AuthContext, departmentId: string | null): boolean {
  if (roleAtLeast(context.role, "owner")) return true;
  if (!departmentId) return false;
  return context.isDeptAdmin && context.primaryDepartmentId === departmentId;
}

/**
 * For pages and actions the department-admin capability guards.
 *
 * Deliberately NOT `requireRole`-shaped, for the reason `requireHr` is not:
 * this is not a floor on the role ladder, and expressing it as one is the
 * mistake the whole change exists to avoid. It takes the department as an
 * argument because, unlike HR, the capability is meaningless without one.
 */
export async function requireDeptAdmin(departmentId: string | null): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!canAdminDepartment(context, departmentId)) {
    throw new ForbiddenError("That department is outside what you administer.");
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
 * Department scope. An owner reaches everything; everyone else must hold
 * team_leader-or-above AND have this department in their managed set. Holding
 * the role alone is not enough — that is the whole point of the managed-set
 * table (D15).
 *
 * ⚠️ `"owner"`, NOT `"admin"`, AND THE DIFFERENCE IS NOT COSMETIC. P8-01 made
 * `admin` a dead rung whose own guarantee is that holding it grants NOTHING —
 * every predicate in the database now reads `>= owner`. Asking for `>= "admin"`
 * here would keep every real user working by accident (owner outranks admin)
 * while quietly handing a legacy or restored `admin` row an admin-shaped UI that
 * every policy behind it refuses. That combination is worse than either half:
 * the screen promises a capability the data layer denies, so the failure arrives
 * as zero rows on a page that offered the button.
 *
 * Same reasoning, same rung, as `canDoHr` — see the note there.
 */
export function canAccessDepartment(context: AuthContext, departmentId: string | null): boolean {
  if (roleAtLeast(context.role, "owner")) return true;
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
 * `null` means "no filter — this user sees everything" (owner). An empty array
 * means "this user leads nothing", and callers MUST treat that as zero rows
 * rather than as no filter. Getting that backwards turns a member into an
 * owner, so it is stated here rather than left to each call site.
 *
 * ⚠️ `"owner"`, NOT `"admin"` — the dead rung must not unfilter a list query.
 * See `canAccessDepartment` above for why the accident is worse than the bug.
 */
export function departmentScopeFilter(context: AuthContext): string[] | null {
  if (roleAtLeast(context.role, "owner")) return null;
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

/**
 * P8-01c — "MAY THIS PERSON SHAPE THIS DEPARTMENT'S STRUCTURE?"
 *
 * Folders, lists and forms: the containers a department's work lives in. Two
 * kinds of person may reshape them and they arrive by different routes:
 *
 *   A LEAD, through `canAccessDepartment` — team_leader-or-above with the
 *   department in their managed set. Unchanged, and still the only route that
 *   also carries approval authority.
 *
 *   A DEPARTMENT ADMIN, through `canAdminDepartment` — the P8-01 tick, on their
 *   own `primaryDepartmentId`, AT ANY RANK. A member holding it reshapes the
 *   team they belong to and approves nothing.
 *
 * ⚠️ AN `||`, AND THE TWO HALVES MUST STAY SEPARATE PREDICATES. The tempting
 * shortcut is to widen `canAccessDepartment` itself, which would be one edit
 * instead of this file plus a dozen call sites — and would be the exact mistake
 * `20260903100100_p8_01b_admin_capability.sql` §7 forbids on the SQL side:
 * `canAccessDepartment` mirrors `vizserve_pms_manages_department`, which is what
 * /approvals, the leave policies and the timesheet queues consult to decide WHO
 * MAY DECIDE. Widening it would hand every department admin the power to approve
 * their own leave. This is a THIRD predicate that reads both, so structure and
 * approval can never be confused again by an edit to either.
 *
 * ⚠️ THE SQL SIDE IS TWO POLICIES, NOT ONE OR-ED EXPRESSION. P8-01c adds
 * permissive policies BESIDE the existing lead policies rather than rewriting
 * them (they are OR-ed, so nobody's access narrows and no policy is ever
 * briefly absent). This function is the single TypeScript reading of the union
 * those two policies produce.
 */
export function canShapeDepartment(context: AuthContext, departmentId: string | null): boolean {
  return canAccessDepartment(context, departmentId) || canAdminDepartment(context, departmentId);
}

/**
 * Does this person shape ANY department at all?
 *
 * The question a page gate and the sidebar can ask, where no particular
 * department is in hand yet — /tasks/lists and /forms both open on a list of
 * everything the caller may touch, and a caller who may touch nothing should be
 * refused before the queries run.
 *
 * ⚠️ `primaryDepartmentId` IS THE ONLY DEPARTMENT THE TICK CAN APPLY TO, so
 * asking about it is asking about the whole capability — there is no second
 * department a department admin might administer. That is the same resolution
 * `app/(app)/layout.tsx` performs for the nav.
 *
 * A `team_leader` who leads nothing yet answers TRUE here, deliberately: that is
 * the pre-P8-01 behaviour of `requireRole("team_leader")`, the state a newly
 * promoted lead is in before somebody maps them to a department, and narrowing
 * it would be this change taking something away.
 */
export function canShapeAnyDepartment(context: AuthContext): boolean {
  return (
    roleAtLeast(context.role, "team_leader") ||
    canAdminDepartment(context, context.primaryDepartmentId)
  );
}

/**
 * For the pages and actions that shape department structure.
 *
 * ⚠️ THIS REPLACES `requireRole("team_leader")` ON EVERY STRUCTURE SCREEN, and
 * the replacement is the point of P8-01c rather than a tidy-up. A department
 * admin may be a MEMBER by rank — that is the entire shape of the capability
 * (D33) — and a member fails `requireRole("team_leader")`. Leaving those gates
 * as they were would have landed the migration and left the layer that reaches
 * it behind, which docs/13-implementation-status.md records four times in two
 * days as this repo's single most repeated failure.
 *
 * Deliberately NOT `requireRole`-shaped, for the reason `requireHr` is not:
 * "shapes a department" is not a floor on the role ladder. It takes no argument
 * because it answers "anything at all" — the per-department decision is
 * `canShapeDepartment`, and every screen behind this gate still makes it.
 */
export async function requireDepartmentShape(): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!canShapeAnyDepartment(context)) {
    throw new ForbiddenError("This area is for team leaders and department admins.");
  }
  return context;
}

export function assertDepartmentShape(context: AuthContext, departmentId: string | null): void {
  if (!canShapeDepartment(context, departmentId)) {
    throw new ForbiddenError("That department is outside what you administer.");
  }
}

/**
 * P8-01c — `departmentPickerScope`, plus the department the tick administers.
 *
 * ⚠️ A SEPARATE FUNCTION RATHER THAN A WIDER `departmentPickerScope`, because
 * the two answer different questions and only one of them may move.
 * `departmentPickerScope` is derived from `departmentScopeFilter`, which is the
 * APPROVAL/visibility scope used by list queries — widening it would put a
 * department admin's team into queues the tick confers no rights over. This one
 * is for the pickers on the STRUCTURE screens: which departments may I file a
 * new folder, list or form under.
 *
 * ⚠️ `none` STILL MEANS DO NOT RUN THE QUERY. The sentinel trap
 * `departmentPickerScope` was written for is unchanged and just as live here:
 * `.in("id", [""])` raises `invalid input syntax for type uuid: ""` (22P02), so
 * "this person shapes nothing" must never become a filter.
 *
 * A `some` list is de-duplicated: a team leader who ALSO holds the tick on a
 * department they lead would otherwise get it twice, and the picker would draw
 * two identical options.
 */
export function departmentShapeScope(context: AuthContext): DepartmentPickerScope {
  const base = departmentPickerScope(context);

  // An owner already reaches everything; there is nothing to add, and adding it
  // would turn `all` into a finite list.
  if (base.kind === "all") return base;

  const own = context.primaryDepartmentId;
  if (!own || !canAdminDepartment(context, own)) return base;

  const ids = base.kind === "some" ? base.ids : [];
  return { kind: "some", ids: ids.includes(own) ? ids : [...ids, own] };
}

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

/*
 * P12 Phase A — the pure rules live in `lib/auth/rules.ts` so the browser can
 * import them. Re-exported here so every authorization concern is still
 * imported from this one module on the server.
 */
export {
  approvesTimesheets,
  canAccessDepartment,
  canAdminDepartment,
  canApproveClientRequest,
  canDoHr,
  canEditUser,
  canManageUsers,
  departmentScopeFilter,
  grantableRoles,
  isApprover,
  isSystemAdmin,
  seesEveryDepartment,
  canManageAnyDepartmentTree,
  canManageDepartmentTree,
  canShapeAnyDepartment,
  canShapeDepartment,
  isCollaborationSpace,
  realtimeDepartmentFilter,
  realtimeDepartmentScope,
  type AuthContext,
} from "@/lib/auth/rules";
import {
  canAccessDepartment,
  canAdminDepartment,
  canDoHr,
  canManageUsers,
  departmentScopeFilter,
  isSystemAdmin,
  canShapeAnyDepartment,
  canShapeDepartment,
  type AuthContext,
} from "@/lib/auth/rules";


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
 * ⚠️ NOT `getSession()`, WHICH READS THE COOKIE AND BELIEVES IT. That is fine
 * for rendering and never fine for a decision, and this function is the input
 * to every decision in the app.
 *
 * `getClaims()` rather than `getUser()` — the same guarantee for no network.
 * `getUser()` asked the Auth server to resolve the token on every render, 160
 * to 400 ms against this project, and the middleware had already paid the same
 * cost moments earlier on the same request: two blocking round trips before a
 * page began its own queries. `getClaims()` verifies the JWT signature locally
 * with WebCrypto against the project's published JWKS, which is why Supabase
 * documents it as safe to trust — the signature is checked every time.
 *
 * ⚠️ The local path needs ASYMMETRIC signing keys; this project publishes an
 * ES256 key. On a symmetric secret `getClaims()` quietly falls back to a
 * network call — still correct, just no longer free. See the longer note in
 * `utils/supabase/middleware.ts`.
 *
 * Returns null for: no session, no profile row, or a deactivated profile.
 * Deactivation is a real gate, not a UI flag.
 */
export const resolveAuth = cache(
  async (): Promise<{ context: AuthContext } | { context: null; denial: AuthDenial }> => {
    const supabase = await createClient();

    const { data: verified } = await supabase.auth.getClaims();

    // `sub` IS the user id — the same value `getUser()` returned as `user.id`,
    // read out of the token this call has just verified rather than out of a
    // response the Auth server composed. Everything downstream is unchanged.
    const userId = verified?.claims.sub ?? null;

    if (!userId) return { context: null, denial: "no_session" };

    /*
     * ⚠️ TWO READS, ONE WAVE — a latency change only, nothing about the answer
     * moves.
     *
     * Both of these need `userId` and nothing else, and `userId` is already in
     * hand: `getClaims()` above verified the token locally, so there is no
     * round trip standing between the two. Yet they used to run one after the
     * other, the managed-departments read not issued until the profile read had
     * come back. That is one wasted blocking round trip on EVERY authenticated
     * request in the app, because every route pays `resolveAuth` before it
     * starts its own queries.
     *
     * They are genuinely independent — nothing in the managed-departments query
     * reads the profile, and every deny branch below discards both together —
     * so they go together and the depth here halves.
     *
     * ⚠️ THE DEGRADE BELOW STAYS SEQUENTIAL AND MUST NOT JOIN THIS WAVE. It is
     * a real dependency: it re-asks the profile question only after inspecting
     * THIS read's error. See `deptAdminColumnMissing`.
     *
     * ⚠️ The managed read is now issued even on the paths that go on to deny —
     * no session profile, deactivated, no app access. That costs one cheap
     * query for a caller who was going to be turned away anyway, and it cannot
     * change the answer, because none of the denial branches ever consulted it.
     * Nor can it turn a transport fault into a throw: PostgREST returns fetch
     * failures as `error` on the result rather than rejecting, so `Promise.all`
     * has nothing to reject on and the error posture is exactly as it was.
     */
    /*
     * ⚠️ P13-01 ADDS A THIRD, AND IT IS A SEPARATE QUERY ON PURPOSE. It names
     * `is_shared`, a column that does not exist until the migration is pasted by
     * hand — and PostgREST rejects a select naming an unknown column WHOLE. Put
     * on the profile read it would answer `not_provisioned` for every person in
     * the company between the deploy and the paste, which is the total outage
     * `deptAdminColumnMissing` exists to describe. In its own query it fails
     * alone, returns no rows, and the collaboration space simply is not there
     * yet. Full account above `loadSharedDepartmentIds`.
     */
    const [attempt, { data: managed }, { data: shared }, { data: held }] = await Promise.all([
      supabase
        .from("vizserve_pms_users")
        .select(`${PROFILE_COLUMNS}, is_dept_admin`)
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("vizserve_pms_user_managed_departments")
        .select("department_id")
        .eq("user_id", userId),
      supabase
        .from("vizserve_pms_departments")
        .select("id")
        .eq("is_shared", true)
        .eq("is_active", true)
        .order("name"),
      // P14-05. Its own query for the reason P13-01 gives above: before the
      // table exists this fails alone and the person simply holds `role`.
      supabase.from("vizserve_pms_user_roles").select("role").eq("user_id", userId),
    ]);

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
        .eq("id", userId)
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

    // `managed` was read in the same wave as the profile above — see the note
    // there. It used to be awaited here, serially, for no reason: it depends
    // only on `userId`, and nothing between there and here can change what it
    // holds.
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
        // P13-01. `?? []` is the degrade AND the pre-migration truth — see the
        // note on the query above and on the field itself.
        sharedDepartmentIds: (shared ?? []).map((row) => row.id),
        // P14-05. Ordered by the ladder, and always including the active role.
        heldRoles: ROLE_ORDER.filter(
          (rung) => rung === profile.role || (held ?? []).some((row) => row.role === rung),
        ),
      },
    };
  },
);

/**
 * P8-11 — is this account holding a password somebody else chose?
 *
 * ⚠️ A SEPARATE READ, DELIBERATELY NOT A COLUMN ON `PROFILE_COLUMNS`, and the
 * reason is written out at length above `deptAdminColumnMissing`: migrations in
 * this repo are pasted by hand AFTER the code is deployed, and a select naming
 * a column that does not exist yet is rejected WHOLE. Adding
 * `must_change_password` to `resolveAuth`'s select would mean that between the
 * deploy and the paste, every signed-in person is answered `not_provisioned` —
 * a total outage, locking out the owner who would have pasted the migration.
 *
 * P8-01 solved that with a second degraded read and a narrow error matcher.
 * That machinery earned its complexity because `is_dept_admin` GRANTS
 * something. This flag only ever WITHHOLDS — it sends somebody to one screen —
 * so the far simpler answer is available: ask separately, and treat every
 * failure as false. Nothing is lost in the window; the flag simply has no
 * holders yet, because nothing can set it until the same migration lands.
 *
 * `cache()`d, so the layout's check costs one read per request.
 */
export const loadMustChangePassword = cache(async (userId: string): Promise<boolean> => {
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_users")
    .select("must_change_password")
    .eq("id", userId)
    .maybeSingle();

  // FALSE ON ANY DOUBT. A missing column, a missing row, an RLS wobble: none of
  // them is evidence that this person is holding a temporary password, and
  // guessing true would trap the whole company on /change-password.
  return data?.must_change_password === true;
});

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

  if (!result.context) {
    if (result.denial === "no_session") redirect("/login");
    redirect(`/no-access?reason=${result.denial}`);
  }

  /*
   * P8-11 — THE TEMPORARY-PASSWORD WALL, and this is the only place it is
   * enforced.
   *
   * Every authenticated page in `(app)` reaches this function, so putting the
   * check here means there is no route that forgets it — the same argument that
   * puts the app-access gate in `resolveAuth` rather than in a layout. It is
   * NOT in `proxy.ts`, which would cost a database read on every request
   * including every static asset the matcher lets through.
   *
   * ⚠️ `/change-password` MUST NOT CALL THIS FUNCTION. It calls `resolveAuth()`
   * directly, for the obvious reason: a screen redirected to itself is a loop,
   * and the loop would be unbreakable because the only way to clear the flag is
   * the form on that page.
   */
  if (await loadMustChangePassword(result.context.userId)) redirect("/change-password");

  return result.context;
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
 * P14-05 — for the configuration screens and their actions: Admin (IT) only.
 * Not `requireRole("admin")`, which would admit Business Manager and CEO.
 */
export async function requireAdmin(): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!isSystemAdmin(context)) {
    throw new ForbiddenError("This area is for the Admin (IT) role.");
  }
  return context;
}


/**
 * P15-03 — the Users page and its actions: Manager and above. What each may
 * change there is bounded by `grantableRoles` / `canEditUser`, which the
 * actions check per user.
 */
export async function requireUserManager(): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!canManageUsers(context)) {
    throw new ForbiddenError("This area is for the Manager and above.");
  }
  return context;
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


export function assertDepartmentAccess(context: AuthContext, departmentId: string | null): void {
  if (!canAccessDepartment(context, departmentId)) {
    throw new ForbiddenError("That department is outside your scope.");
  }
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
/**
 * P11-07 — the picker scope that goes with `canManageDepartmentTree`.
 *
 * `departmentShapeScope` plus the department the caller BELONGS to, so the
 * department picker on /tasks/lists offers a member their own team. Without it
 * the screen opens with an empty Select and a New list button that cannot be
 * satisfied.
 */
export function departmentTreeScope(context: AuthContext): DepartmentPickerScope {
  const base = departmentShapeScope(context);

  if (base.kind === "all") return base;

  /*
   * P13-01 — the collaboration spaces go in for everybody, and they go in
   * BEFORE the early return below. A person with no department of their own
   * used to fall straight through to `base`; they can shape the shared space
   * like anybody else, so returning here would give them the empty picker this
   * function exists to prevent.
   */
  const ids = base.kind === "some" ? [...base.ids] : [];
  for (const shared of context.sharedDepartmentIds) {
    if (!ids.includes(shared)) ids.push(shared);
  }

  const own = context.primaryDepartmentId;
  if (own && !ids.includes(own)) ids.push(own);

  // Still the sentinel rule: "shapes nothing" must stay `none`, never a filter
  // that matches nothing. See `departmentPickerScope`.
  return ids.length === 0 ? { kind: "none" } : { kind: "some", ids };
}

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



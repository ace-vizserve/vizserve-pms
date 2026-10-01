/**
 * The authorization RULES — the pure predicates over `AuthContext` — with NO
 * server-only import, so the browser can apply the same answers when it draws a
 * control (P12 Phase A: pages read from the query cache and no longer render on
 * the server per click).
 *
 * ⚠️ STILL ONE LAYER. `lib/auth/authorization.ts` re-exports every one of these,
 * and it is still where the server resolves who somebody is. Nothing here grants
 * anything by itself: a predicate drawn in the browser decides whether a button
 * shows, and RLS and the database functions decide whether the write lands.
 */
import { roleAtLeast, type Role } from "@/lib/auth/roles";
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
  /**
   * P13-01 — THE COLLABORATION SPACES. Departments flagged `is_shared`:
   * "Collaboration Projects (All departments)" and any other one an owner
   * creates later.
   *
   * ⚠️ NOT SOMETHING THIS PERSON HOLDS. Every other field on this context is
   * about the user; this one is the same short list for everybody signed in,
   * and it rides along for the reason `gender` does — it is needed by the
   * predicates below on almost every page, and a second read per screen for two
   * rows that never change would be waste.
   *
   * ⚠️ IT GRANTS, SO THE EMPTY DEGRADE HAD TO BE PROVED SAFE RATHER THAN
   * ASSUMED. Empty means "there are no collaboration spaces", which is exactly
   * true before the migration is pasted — the flag does not exist, so nothing is
   * flagged, so no policy admits anybody anywhere new. The failure direction is
   * "the space is not there yet", never "everyone is in everything".
   */
  sharedDepartmentIds: string[];
  /**
   * P14-05 — every role this person HOLDS. `role` above is the one they are
   * acting as, always one of these, and what every check reads. More than one
   * entry is what puts the role switcher in the top bar.
   *
   * Optional so a context built before the table exists (or in a test) reads
   * as "holds only `role`".
   */
  heldRoles?: Role[];
};


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
  // P14-05. Manager and above see the HR screens, as `vizserve_pms_is_hr()` does.
  return context.isHr || roleAtLeast(context.role, "manager");
}

/**
 * P14-05 — Admin is IT: the configuration screens (users and roles, settings,
 * events, audit trail) are theirs ALONE. An equality test on purpose — CEO and
 * Business Manager outrank `admin` on the ladder and must not inherit it.
 * Mirrors `vizserve_pms_is_system_admin()`.
 */
export function isSystemAdmin(context: Pick<AuthContext, "role">): boolean {
  return context.role === "admin";
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
 * P14 — Admin, Business Manager and CEO: the oversight roles that see every
 * department. Mirrors `vizserve_pms_is_admin()`, which P14-05 re-pointed to
 * `admin` and above. Confers no approval — see `isApprover`.
 */
export function seesEveryDepartment(context: Pick<AuthContext, "role">): boolean {
  return roleAtLeast(context.role, "admin");
}

/**
 * The department filter for list queries, by the ACTIVE role.
 *
 * `null` means "no filter — this user sees everything" (Manager and up). An
 * empty array means "this user leads nothing", and callers MUST treat that as
 * zero rows rather than as no filter. Getting that backwards turns a member into
 * an owner, so it is stated here rather than left to each call site.
 *
 * ⚠️ P14 — THIS, NOT RLS ALONE, IS WHAT A "MY TEAM" VIEW SCOPES BY. The HR tick
 * widens the reads on users, DTR and internal requests to the whole company
 * (`vizserve_pms_is_hr()`) whatever role the person is acting as. That is right
 * for the HR screens and wrong for a Team Leader's team week, which must show
 * their team and nobody else.
 */
export function departmentScopeFilter(
  context: { role: Role; managedDepartmentIds: readonly string[] },
): string[] | null {
  if (seesEveryDepartment(context)) return null;
  // P14-04. The manager oversees every department — `vizserve_pms_manages_department` says so.
  if (context.role === "manager") return null;
  if (!roleAtLeast(context.role, "team_leader")) return [];
  return [...context.managedDepartmentIds];
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
export function canAccessDepartment(
  context: { role: Role; managedDepartmentIds: readonly string[] },
  departmentId: string | null,
): boolean {
  // P14-05. Admin, Business Manager and CEO see every department — `vizserve_pms_is_admin()`.
  if (seesEveryDepartment(context)) return true;
  // P14-04. The manager oversees every department — `vizserve_pms_manages_department` says so.
  if (context.role === "manager") return true;
  if (!departmentId) return false;
  return (
    roleAtLeast(context.role, "team_leader") && context.managedDepartmentIds.includes(departmentId)
  );
}

/*
 * P14-04 — WHO APPROVES. Approval is a job, not a rank: these are EQUALITY tests
 * on purpose, so CEO (owner), Business Manager and Admin approve nothing even
 * though they outrank the Manager. Mirrors `vizserve_pms_can_approve`,
 * `vizserve_pms_team_leaders_of` and `vizserve_pms_managers`
 * (20260930100000_p14_04_approval_routing.sql). For display only — the
 * database functions are the authority.
 */

/** Has any approval queue at all: Team Leaders and the Manager. */
export function isApprover(context: Pick<AuthContext, "role">): boolean {
  return context.role === "team_leader" || context.role === "manager";
}

/** Timesheets go straight to the Manager. */
export function approvesTimesheets(context: Pick<AuthContext, "role">): boolean {
  return context.role === "manager";
}

/** Client Gate 1: a Team Leader of that department, or the Manager. */
export function canApproveClientRequest(
  context: Pick<AuthContext, "role" | "managedDepartmentIds">,
  departmentId: string | null,
): boolean {
  if (context.role === "manager") return true;
  if (context.role !== "team_leader" || !departmentId) return false;
  return context.managedDepartmentIds.includes(departmentId);
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
 * P13-01 — "IS THIS THE SPACE EVERYBODY SHARES?"
 *
 * The TypeScript reading of `vizserve_pms_may_collaborate`, which is the
 * enforcement. Both answer the same two-part question — the department is an
 * active collaboration space, and the caller is an active user — and the second
 * half is free here: `resolveAuth` returns no context at all for a deactivated
 * or access-revoked account, so by the time there is an `AuthContext` to pass
 * in, it holds.
 *
 * ⚠️ A SEPARATE PREDICATE RATHER THAN A CLAUSE INSIDE `canAccessDepartment`, and
 * the reason is the one P11-07 gives for `canManageDepartmentTree` existing at
 * all. `canAccessDepartment` is the APPROVAL AND VISIBILITY scope — it decides
 * whose requests you review, whose DTR you read, whose timesheet week you sign
 * off. Nobody leads the collaboration space and it holds no queue; widening that
 * predicate would hand every member of the company a scope over work that has no
 * approver, which is not what a shared list of tasks is.
 *
 * So this is OR-ed only into the two questions it actually answers: may I shape
 * this department's tree, and may I file work into it.
 */
export function isCollaborationSpace(
  context: AuthContext,
  departmentId: string | null,
): boolean {
  if (!departmentId) return false;
  return context.sharedDepartmentIds.includes(departmentId);
}


export function canShapeAnyDepartment(context: AuthContext): boolean {
  return (
    roleAtLeast(context.role, "team_leader") ||
    canAdminDepartment(context, context.primaryDepartmentId)
  );
}


/**
 * P8-03 — WHICH DEPARTMENTS' TASK ROWS SHOULD PUSH A REFRESH TO THIS PERSON?
 *
 * ⚠️ THIS IS NOT AN ENFORCEMENT BOUNDARY, AND IT MUST NEVER BE USED TO DECIDE
 * WHAT A QUERY RETURNS. RLS decides that, and it is the only thing that does.
 * The answer here becomes a Supabase Realtime `filter` string — a hint sent to
 * the Realtime server about which row events are worth delivering. Every event
 * that survives it is STILL authorized against the subscriber's own JWT through
 * the same `vizserve_pms_tasks` SELECT policy a page render goes through. Widen
 * this and nobody sees a row they could not already select; narrow it and
 * somebody's page is stale. Those are the only two failure modes, and they are
 * both about freshness, never about access.
 *
 * WHAT IT RETURNS: the union of the department the person BELONGS to
 * (`primaryDepartmentId`) and the departments they LEAD
 * (`managedDepartmentIds`), de-duplicated. A lead is normally mapped to the
 * department they also belong to, so the two overlap and the duplicate would
 * otherwise reach the filter string as `in.(x,x)`.
 *
 * ⚠️ DELIBERATELY NOT `departmentScopeFilter`, AND REUSING IT WOULD BE WRONG IN
 * BOTH DIRECTIONS. That function is the APPROVAL/visibility scope for list
 * queries, and its two edge answers are exactly the two this cannot accept:
 *
 *   `[]` FOR A PLAIN MEMBER — "leads nothing". Correct there; wrong here. A
 *   member does see their own department's tasks (the policy's
 *   "same department and not personal" branch), and an empty set would mean
 *   they never subscribe at all — the one group whose board would stay dead.
 *
 *   `null` FOR AN OWNER — "no filter". In a list query that means "RLS shows
 *   you everything". In a subscription it would mean AN UNFILTERED STREAM,
 *   which is the single thing this design forbids: every task event in the
 *   company, authorized per subscriber, to deliver a ping. Passing `null`
 *   through by accident is not a small bug, it is the firehose.
 *
 * ⚠️ TWO DELIBERATE GAPS. BOTH ARE NARROWING-ONLY — the cost is a stale page,
 * never a leaked row, and a stale page is what every page in this app is today.
 *
 *   AN OWNER GETS ONLY THEIR OWN AND MANAGED DEPARTMENTS, NOT THE COMPANY. An
 *   owner can see every task, so a "correct" filter would have to enumerate
 *   every department id in the business — a list that goes stale the moment
 *   somebody adds a department, and one more query on every page load to build
 *   it. The alternative, no filter, is the firehose above. So an owner's board
 *   pushes for the departments they belong to or lead and is stale elsewhere
 *   until they navigate, which is precisely today's behaviour: no regression,
 *   just an improvement that did not reach as far as it could.
 *
 *   A TASK ASSIGNED TO YOU IN ANOTHER DEPARTMENT WILL NOT PUSH. The SELECT
 *   policy's `assignee_id`, `qa_assignee_id` and `vizserve_pms_is_on_task`
 *   branches all reach outside your departments, and a single-column filter
 *   cannot express "or I am named on it". You can open the task and see it; you
 *   just are not told the moment it changes. Same conservative failure.
 *
 * Closing either one properly means a second channel keyed on `assignee_id`,
 * not a wider department filter — see the note in
 * `supabase/migrations/20260903120000_p8_03_realtime.sql`.
 */
export function realtimeDepartmentScope(context: AuthContext): string[] {
  const ids: string[] = [];

  // The department they belong to comes first, so a member's single-department
  // filter is an `eq.` rather than a one-element `in.()`.
  if (context.primaryDepartmentId) ids.push(context.primaryDepartmentId);

  for (const id of context.managedDepartmentIds) {
    if (!ids.includes(id)) ids.push(id);
  }

  /*
   * P13-01 — the collaboration space, for everybody.
   *
   * ⚠️ NEITHER OF THE TWO DELIBERATE GAPS ABOVE APPLIES HERE, which is why this
   * is added rather than left to the "stale until you navigate" default. It is
   * not the firehose an owner's full-company filter would be: it is one
   * department id, the same one for every subscriber, already in hand on the
   * context and needing no extra query. And a shared board is precisely where
   * staleness bites hardest — four teams typing into one list is the case the
   * space exists for, and it is the case where a page that does not repaint
   * shows somebody work that was already picked up.
   */
  for (const id of context.sharedDepartmentIds) {
    if (!ids.includes(id)) ids.push(id);
  }

  return ids;
}


/**
 * P8-03 — the same scope, serialized as a Supabase Realtime `filter` string.
 *
 * ⚠️ `null` MEANS DO NOT SUBSCRIBE, AND EVERY CALLER MUST TREAT IT THAT WAY.
 * This is the same trap `departmentPickerScope` was written for, one layer
 * further out: there is no such thing as a filter that matches nothing. An
 * empty scope cannot become `department_id=in.()` — the Realtime server would
 * reject or, worse, ignore the clause and hand back an unfiltered stream. So
 * "this person belongs to no department and leads none" resolves to `null`, and
 * `useRealtimeRefresh` declines to open a channel at all.
 *
 * That state is real, not hypothetical: a newly created account with no
 * department mapping is in it until somebody maps them. Their pages simply
 * behave as they did before this phase.
 *
 * THE GRAMMAR. Postgres Changes filters are `column=operator.value` and the
 * operator set is PostgREST's minus the containment/range/full-text ones —
 * `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `like`, `ilike`, `is`, `match`,
 * `imatch`, `isdistinct` (verified in
 * `@supabase/realtime-js/dist/module/RealtimePostgresFilterBuilder.d.ts`). `in`
 * IS supported, so several departments are one channel rather than one channel
 * per department — which matters because each channel is its own subscription
 * the server authorizes separately.
 *
 * No quoting or escaping is applied and none is needed: these are uuids out of
 * the database, and a uuid contains none of the reserved characters (`,`, `(`,
 * `)`, `"`, `\`) that PostgREST-style quoting exists for. If this is ever reused
 * for a free-text column, use `postgresChangesFilter()` from realtime-js instead
 * of building the string by hand.
 */
export function realtimeDepartmentFilter(context: AuthContext): string | null {
  const ids = realtimeDepartmentScope(context);

  if (ids.length === 0) return null;
  if (ids.length === 1) return `department_id=eq.${ids[0]}`;

  return `department_id=in.(${ids.join(",")})`;
}


/**
 * The page-gate half: does this person have a tree to manage at all?
 *
 * Everyone with a department does, which is nearly everyone — the check exists
 * for the person who has none, where `/tasks/lists` would open on an empty
 * screen with no department to create anything in.
 */
export function canManageAnyDepartmentTree(context: AuthContext): boolean {
  return (
    canShapeAnyDepartment(context) ||
    context.primaryDepartmentId !== null ||
    // P13-01. Somebody with no department of their own still has the
    // collaboration space to organise, so the page is worth rendering.
    context.sharedDepartmentIds.length > 0
  );
}


/**
 * P11-07 — "MAY THIS PERSON RESHAPE THIS DEPARTMENT'S LISTS AND FOLDERS?"
 *
 * A THIRD PREDICATE RATHER THAN A WIDENING OF `canShapeDepartment`, and the
 * reason is the one that file's own ⚠️ note gives about `canAccessDepartment`:
 * widening the existing one would be a single edit instead of this function
 * plus its call sites, and it would carry along everything else that predicate
 * gates. `canShapeDepartment` still answers for FORMS, which are a client-facing
 * contract and stay with leads and the Admin tick.
 *
 * The project tree is not that. Amier, 8 Sep: a list is a shelf, not a
 * permission boundary, and needing a Team Leader to make one is how people end
 * up keeping their work somewhere else. So this admits a shaper OR anybody who
 * simply belongs to the department.
 *
 * Mirrors the policies in `p11_07`, which is the enforcement. `primary_department_id`
 * is what this schema means by "a member of a department" everywhere else — the
 * same test `vizserve_pms_create_task` uses to decide where a member may file
 * work.
 */
export function canManageDepartmentTree(
  context: AuthContext,
  departmentId: string | null,
): boolean {
  if (canShapeDepartment(context, departmentId)) return true;
  if (!departmentId) return false;
  if (isCollaborationSpace(context, departmentId)) return true;
  return context.primaryDepartmentId === departmentId;
}


/*
 * P15-03 — WHO MANAGES PEOPLE.
 *
 * Manager and above (Manager, Admin, Business Manager, CEO) open the Users
 * page. What each may DO there is bounded by rank, so the page cannot be used
 * to climb:
 *
 *   - Admin (IT) grants and edits anything, as before P15-03.
 *   - Everyone else grants only roles BELOW their own, never Admin, and edits
 *     only people whose every role is one they could have granted. They cannot
 *     edit themselves.
 *
 * Equality on `admin`, not the ladder: Business Manager and CEO outrank Admin
 * on it, and Admin is the IT job, not a rung they should be able to hand out.
 */
export const GRANTABLE_ROLE_ORDER: Role[] = ["owner", "business_manager", "admin", "manager", "team_leader"];

export function canManageUsers(context: Pick<AuthContext, "role">): boolean {
  return roleAtLeast(context.role, "manager");
}

/** The roles this viewer may tick for somebody, most senior first. */
export function grantableRoles(viewerRole: Role): Role[] {
  if (viewerRole === "admin") return GRANTABLE_ROLE_ORDER;
  if (!roleAtLeast(viewerRole, "manager")) return [];
  return GRANTABLE_ROLE_ORDER.filter((role) => role !== "admin" && !roleAtLeast(role, viewerRole));
}

/** May this viewer edit somebody holding these roles? */
export function canEditUser(
  viewer: Pick<AuthContext, "role" | "userId">,
  target: { id: string; roles: readonly Role[] },
): boolean {
  if (viewer.role === "admin") return true;
  if (!roleAtLeast(viewer.role, "manager") || target.id === viewer.userId) return false;
  const grantable = grantableRoles(viewer.role);
  return target.roles.every((role) => role === "member" || grantable.includes(role));
}

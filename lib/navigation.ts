// `roles.ts`, NOT `authorization.ts`. The type import above used to be enough
// because it is erased at build time; `roleAtLeast` is a VALUE, and importing it
// from the authorization module would drag `server-only` into the sidebar and
// break every client component that renders the nav. `roles.ts` exists for
// exactly this — it is the half of the hierarchy that is safe on the client.
import { roleAtLeast, type Role } from "@/lib/auth/roles";

/**
 * The six modules behind one login (docs/01-updated-workflow.md §0).
 *
 * Modules that are not built yet still render, disabled — "so the shape is
 * visible" (P0-07). A nav that grows a new item every phase reads as an
 * unfinished tool; a nav that is complete on day one and fills in reads as a
 * plan. It also stops anyone quietly reinventing a module in the wrong place.
 */

/**
 * A route that lives UNDER another nav item.
 *
 * `/timesheet/team` was a top-level entry beside `/timesheet`, and the two were
 * siblings in the rail while being parent and child in the URL. That is not only
 * untidy: the active check is `startsWith`, so standing on `/timesheet/team` lit
 * BOTH rows at once and the sidebar claimed you were in two places.
 *
 * Children carry their own `minRole`, because a parent everyone can reach can
 * still hold a child they cannot — Tasks is for everybody and Lists is a team
 * leader's screen.
 */
export type NavChild = {
  label: string;
  href: string;
  /** Inclusive floor — `role >= minRole` (D15). Defaults to the parent's. */
  minRole?: Role;
  /** See `NavItem.requiresHr`. Applied on top of `minRole`, never instead. */
  requiresHr?: boolean;
  /** See `NavItem.requiresDeptAdmin`. Applied on top of `minRole`, never instead. */
  requiresDeptAdmin?: boolean;
};

export type NavItem = {
  label: string;
  href: string;
  /** Inclusive floor — `role >= minRole` (D15). */
  minRole: Role;
  /**
   * P7-52. Requires the HR capability, which is ORTHOGONAL to `minRole` rather
   * than a point on it — so the two are ANDed, never substituted. An HR row
   * keeps `minRole: "member"`, because an HR person may be a member and the
   * ladder has nothing to say about the job they hold.
   */
  requiresHr?: boolean;
  /**
   * P8-01. Requires the department-admin capability, which — like `requiresHr`
   * and for the same reason (D33) — is ORTHOGONAL to `minRole` rather than a
   * point on it, so the two are ANDed, never substituted. A department-admin
   * row keeps `minRole: "member"`, because the holder may be a member: that is
   * the entire shape of the capability.
   *
   * ⚠️ Like `requiresHr`, this does NOT inherit to children — see the note in
   * `visibleNavItems`. A child under a parent that does not require it must say
   * so itself, because there is nothing above it to have already cleared.
   *
   * NOTHING SETS THIS YET. P8-01a is the role model only; the screens a
   * department admin reaches are a separate follow-up. It is declared now so
   * that the follow-up adds a field to a row rather than a concept to the nav.
   */
  requiresDeptAdmin?: boolean;
  /** False until the phase that builds it lands. */
  enabled: boolean;
  /** Shown on the disabled state so the reason is obvious. */
  phase?: string;
  icon: NavIconName;
  /**
   * Sub-routes, rendered as a collapsible sub-menu.
   *
   * THE FIRST CHILD IS THE PARENT'S OWN ROUTE, deliberately. A parent whose
   * label navigates AND whose children navigate gives two ways to reach the same
   * screen with only one of them highlighted; making the index an explicit child
   * ("List", "My week") means every destination in the tree is a row, and the
   * parent is purely a disclosure.
   */
  children?: NavChild[];
};

export type NavIconName =
  | "dashboard"
  | "clock"
  | "check"
  | "form"
  | "form-fill"
  | "inbox-stack"
  | "tasks"
  | "timesheet"
  | "reports"
  | "inbox"
  | "users"
  | "calendar-off"
  | "calendar-days"
  | "settings"
  | "history"
  | "hr"
  | "leave-type"
  | "attendance";

export const NAV_ITEMS: NavItem[] = [
  {
    // NO "Home" ENTRY. "/" is a standalone page outside the (app) shell — it
    // has no sidebar to appear in. The lockup at the top of the sidebar is the
    // way back to it.
    label: "Dashboard",
    href: "/dashboard",
    minRole: "member",
    enabled: true,
    icon: "dashboard",
  },
  {
    label: "Forms",
    href: "/forms",
    minRole: "team_leader",
    enabled: true,
    icon: "form",
  },
  {
    label: "Requests",
    href: "/requests",
    minRole: "team_leader",
    enabled: true,
    icon: "inbox-stack",
  },
  {
    /*
     * P7-66 Phase 4b — "FILL A FORM", NOT "FORMS", and the longer label is the
     * point rather than an accident.
     *
     * `/forms` above is the BUILDER and it is `team_leader`. This is where a
     * member goes to ANSWER a published internal form, and it is
     * `member`. Two rows both called "Forms", one visible to everybody and one
     * to leads, is the sidebar telling two different people the same word means
     * two different screens — and the person who has both would have no way to
     * tell them apart in the rail at all. A slightly long label is cheaper than
     * that, and it also names the ACTION, which is what somebody arriving here
     * is trying to do.
     *
     * Deliberately NOT a child of Forms: a child inherits the disclosure and
     * the parent, and a member cannot see the parent.
     */
    label: "Fill a form",
    href: "/respond",
    minRole: "member",
    enabled: true,
    icon: "form-fill",
  },
  /*
   * NO "TASKS" ENTRY, and its absence is the design rather than an omission.
   *
   * It used to sit here as a disclosure holding "List", "Board" and "Lists" —
   * beside a Projects group that is ALSO tasks, organised by where they live.
   * Two headings for one thing, and the redundancy was the smaller half of the
   * problem: the Board could not filter by list at all, so a list opened from
   * Projects had exactly one shape available to it and the two structures never
   * met.
   *
   * The shape now follows ClickUp, which is what D21 says to borrow: the
   * sidebar holds WHERE the work lives (Space → Folder → List) and List/Board
   * are VIEWS OF WHATEVER YOU OPENED, as tabs on the page. `TaskToolbar` was
   * already built that way and already carried the query string across; the
   * only thing missing was the list filter, which the board now honours.
   *
   * `/tasks` (all tasks) and `/tasks/lists` (managing them) are both reached
   * from the Projects group — see `nav-projects.tsx`. Neither route changed and
   * both still enforce their own role check.
   */
  {
    label: "DTR",
    href: "/dtr",
    minRole: "member",
    enabled: true,
    icon: "clock",
  },
  {
    label: "Approvals",
    href: "/approvals",
    minRole: "member",
    enabled: true,
    icon: "check",
  },
  {
    label: "Timesheet",
    href: "/timesheet",
    minRole: "member",
    children: [
      { label: "My week", href: "/timesheet" },
      // P6-05 / slice E1. Team leaders and up: this is where submitted weeks are
      // approved, and where the submit notification's `link_path` points
      // (`20260818110000_p7_05_timesheet_weeks.sql:339`). A member has nobody to
      // review, and the page says so rather than 404ing if they reach it.
      { label: "Team week", href: "/timesheet/team", minRole: "team_leader" },
    ],
    // Enabled with P6-02/P6-03. The route exists and the table behind it does
    // too; leaving it disabled would now be the nav lying in the other
    // direction, which is worse than the placeholder it replaced.
    enabled: true,
    icon: "timesheet",
  },
  {
    label: "Inbox",
    href: "/inbox",
    minRole: "member",
    enabled: true,
    icon: "inbox",
  },
  // ---------------------------------------------------------------------------
  // P8-01 — THE ADMIN GROUP IS `minRole: "owner"`, NOT `"admin"`.
  //
  // Every page below is `requireRole("owner")`. Leaving the floor at the dead
  // `admin` rung would put these rows in the rail for a legacy or restored
  // `admin` row and then throw ForbiddenError when they clicked one — a door
  // offered to people it does not open for, which 13-implementation-status.md
  // already records as the P7-14 failure. The nav must agree with the gate.
  // ---------------------------------------------------------------------------
  {
    label: "Users",
    href: "/admin/users",
    minRole: "owner",
    // Re-enabled on merge. This was correctly disabled on main because the
    // route 404ed — P0-04 has since been built, so the screen it was waiting
    // for now exists.
    enabled: true,
    icon: "users",
  },
  {
    label: "Holidays",
    href: "/admin/holidays",
    // P7-52 moved this from `minRole: "admin"` to the HR capability, and moved
    // the row into the HR group below. The URL is unchanged — an admin has this
    // page bookmarked and a link in the audit trail points at it — only who
    // reaches it and where it appears in the rail.
    //
    // Holidays became HR's because D31 made this table the only authority on
    // which days the company is shut, and D32 recorded that editing a past one
    // rewrites reported leave. That consequence is entitlement, which is HR's
    // job, not administration.
    minRole: "member",
    requiresHr: true,
    // P7-35. Restricted to EDIT — what it produces is read by everybody, on the
    // shared calendar on the home page. That is why there is no member-level
    // entry for it: there is nothing to navigate to, the result is already
    // where they are looking.
    enabled: true,
    icon: "calendar-off",
  },
  {
    label: "Events",
    href: "/admin/events",
    minRole: "owner",
    // P7-46. Sits directly under Holidays because the two are the halves of
    // "what is on the calendar that is not leave" — and because the difference
    // between them matters: a holiday is a day off and changes leave
    // arithmetic, an event is a thing happening and changes nothing.
    enabled: true,
    icon: "calendar-days",
  },
  {
    label: "Settings",
    href: "/admin/settings",
    minRole: "owner",
    // P7-37. Company-wide rules, read by everybody and written by nobody else.
    // Sits with Holidays for the same reason: both are policy an admin sets
    // once and the whole app then obeys silently.
    enabled: true,
    icon: "settings",
  },
  {
    label: "Audit trail",
    href: "/admin/audit",
    minRole: "owner",
    // P0-09. The table has been written to since Phase 0 by every server action
    // and by a dozen SQL functions; this is the first thing that reads it.
    //
    // LAST in the group, and that is the ordering rule rather than an accident:
    // everything above it is a screen you change something on, and this is the
    // one you open to find out what somebody already changed.
    enabled: true,
    icon: "history",
  },

  // ---------------------------------------------------------------------------
  // P7-52 — the HR group.
  //
  // EVERY ROW HERE IS `minRole: "member"` AND `requiresHr: true`, and that pair
  // is the whole point of the change: HR is a job, not a rank, so the ladder
  // floor stays at the bottom and the capability does the gating. Writing these
  // as `minRole: "admin"` would work today — an admin is HR — and would silently
  // hide the entire section from the HR person this was built for.
  // ---------------------------------------------------------------------------
  {
    label: "Leave balances",
    href: "/hr/balances",
    minRole: "member",
    requiresHr: true,
    // The org-wide version of the per-person panel buried in the /admin/users
    // editor dialog. First screen that reads a whole year across everybody,
    // which is the read p7_33:220-222 predicted and P7-52 finally indexed for.
    enabled: true,
    icon: "users",
  },
  {
    label: "Leave types",
    href: "/hr/leave-types",
    minRole: "member",
    requiresHr: true,
    // P7-12 created this table with an admin-write policy and NO SCREEN AT ALL.
    // label, sort_order, is_active, applies_to_gender and calendar_visibility
    // have been SQL-editor-only since. D25 called types "policy data HR will
    // change" — this is the first time HR can actually change them.
    enabled: true,
    icon: "leave-type",
  },
  {
    label: "Leave reports",
    href: "/hr/reports",
    minRole: "member",
    requiresHr: true,
    // P7-53's two modes and four filters. The /admin/users toolbar button still
    // exists and now calls the same action — this is the version with the
    // filters exposed.
    enabled: true,
    icon: "reports",
  },
  {
    label: "Attendance",
    href: "/hr/attendance",
    minRole: "member",
    requiresHr: true,
    enabled: true,
    icon: "attendance",
  },
];

/**
 * A count for a sidebar badge, or null when there is nothing to show.
 *
 * NULL AT ZERO, not "0". A badge reading zero is worse than no badge: it
 * draws the eye to a row with nothing behind it, and after a week people stop
 * looking at the one that does have something.
 *
 * Capped at "99+" because the sidebar rail is a fixed width and a four-digit
 * count either truncates or pushes the label out of the row. Beyond about
 * fifty the exact number changes nothing anybody does.
 *
 * Formatted HERE rather than in the sidebar, so a badge is a pre-rendered
 * string by the time it reaches the component — arithmetic in a presentation
 * component is how two badges end up capping differently.
 */
export function formatNavBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/**
 * Nav filtering is presentation, not authorization. Hiding a link protects
 * nobody — every route re-checks through lib/auth/authorization.ts, and RLS
 * re-checks under that.
 *
 * P7-52 deleted a second, module-local `ROLE_ORDER` that used to sit here and
 * delegated to the canonical one. `lib/auth/roles.ts` warns in as many words
 * against exactly that copy, and adding a second gating dimension below was the
 * wrong moment to be maintaining two versions of the first.
 */
export function roleAllows(role: Role, required: Role): boolean {
  return roleAtLeast(role, required);
}

/**
 * P7-52 — who is looking, beyond their rank.
 *
 * A bag rather than a second positional argument, so the next orthogonal
 * capability is a field here instead of another parameter every caller has to
 * thread through in the right order.
 */
export type NavViewer = {
  /** `canDoHr(context)`, NOT `context.isHr` — owners hold it without the flag. */
  isHr?: boolean;
  /**
   * P8-01. `canAdminDepartment(context, context.primaryDepartmentId)`, NOT
   * `context.isDeptAdmin` — owners hold it without the flag, and the capability
   * is meaningless without a department to evaluate it against. The nav can
   * only ask "does this person administer anything at all", so the caller
   * resolves it against their OWN department and passes the answer.
   */
  isDeptAdmin?: boolean;
};

/** True when this row's capability requirements are met. Role is checked apart. */
function capabilityAllows(
  item: { requiresHr?: boolean; requiresDeptAdmin?: boolean },
  viewer: NavViewer,
): boolean {
  if (item.requiresHr && viewer.isHr !== true) return false;
  // The default is DENY, exactly as it is for HR above: a caller that forgets to
  // pass the viewer gets a nav with these rows missing, which is a visible bug.
  // The other default would show them to everybody, which is a silent one.
  if (item.requiresDeptAdmin && viewer.isDeptAdmin !== true) return false;
  return true;
}

export function visibleNavItems(role: Role, viewer: NavViewer = {}): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => roleAllows(role, item.minRole) && capabilityAllows(item, viewer),
  ).map((item) => {
    if (!item.children) return item;

    // A child with no `minRole` inherits the parent's, which the filter above
    // has already cleared — so only the ones that RAISE the floor are re-checked.
    // NEITHER `requiresHr` NOR `requiresDeptAdmin` INHERITS: a child under a
    // parent that does not require the capability must say so itself, because
    // there is nothing above it to have already cleared.
    const children = item.children.filter(
      (child) =>
        (!child.minRole || roleAllows(role, child.minRole)) && capabilityAllows(child, viewer),
    );

    // One child left means the sub-menu is the parent restated. Collapse it back
    // to a plain row rather than drawing a disclosure that reveals a single
    // link to where you already are — which is what a member would see under
    // Timesheet once Team week is filtered out.
    return children.length > 1 ? { ...item, children } : { ...item, children: undefined };
  });
}

/**
 * Sidebar grouping.
 *
 * Kept as a separate map rather than a `group` field on each item, so the
 * grouping is readable in one place and reordering a section does not mean
 * editing nine scattered literals.
 *
 * The order below is the order of the day: what is on your plate, then the
 * things you file, then the things you administer. `Admin` is pinned to the
 * bottom of the sidebar rather than sitting in the flow.
 */
export type NavGroup = { label: string; hrefs: string[]; pinBottom?: boolean };

export const NAV_GROUPS: NavGroup[] = [
  // `/tasks` is NOT here any more. Tasks are reached through the Projects tree,
  // which is its own group rendered between the flow and the pinned sections —
  // listing the route here as well is what put two task headings in the rail.
  // `/respond` sits between the queue a lead works and the inbox everybody
  // reads: it is a thing on your plate, which is what this group is.
  { label: "Work", hrefs: ["/dashboard", "/requests", "/respond", "/inbox"] },
  // `/timesheet/team` is NOT here any more — it is a child of `/timesheet` and
  // is reached through it. Listing a child href beside its parent is what put
  // them side by side in the rail in the first place.
  { label: "Time", hrefs: ["/dtr", "/approvals", "/timesheet"] },
  { label: "Manage", hrefs: ["/forms", "/reports"] },
  // P7-52. Above Admin and below Manage: HR is a job somebody does daily, not
  // an administration screen you open when something is wrong. Pinned only by
  // sitting here — `pinBottom` stays Admin's, so an HR person who is not an
  // admin sees this as their last section and nothing beneath it.
  {
    label: "HR",
    hrefs: [
      "/hr/balances",
      "/hr/leave-types",
      // Lives at /admin/holidays and always has. Grouped here because that is
      // whose job it is now, not because of where the file sits.
      "/admin/holidays",
      "/hr/reports",
      "/hr/attendance",
    ],
  },
  {
    label: "Admin",
    hrefs: [
      "/admin/users",
      "/admin/events",
      "/admin/settings",
      "/admin/audit",
    ],
    pinBottom: true,
  },
];

/**
 * The role's visible items, bucketed into groups. Empty groups are dropped, so
 * a member never sees a "Manage" heading with nothing under it.
 */
export function groupedNavItems(
  role: Role,
  viewer: NavViewer = {},
): { group: NavGroup; items: NavItem[] }[] {
  const visible = visibleNavItems(role, viewer);

  return NAV_GROUPS.map((group) => ({
    group,
    items: group.hrefs
      .map((href) => visible.find((item) => item.href === href))
      .filter((item): item is NavItem => Boolean(item)),
  })).filter(({ items }) => items.length > 0);
}

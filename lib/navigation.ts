import type { Role } from "@/lib/auth/authorization";

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
};

export type NavItem = {
  label: string;
  href: string;
  /** Inclusive floor — `role >= minRole` (D15). */
  minRole: Role;
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
  | "inbox-stack"
  | "tasks"
  | "timesheet"
  | "reports"
  | "inbox"
  | "users"
  | "calendar-off"
  | "calendar-days"
  | "settings"
  | "history";

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
  {
    label: "Users",
    href: "/admin/users",
    minRole: "admin",
    // Re-enabled on merge. This was correctly disabled on main because the
    // route 404ed — P0-04 has since been built, so the screen it was waiting
    // for now exists.
    enabled: true,
    icon: "users",
  },
  {
    label: "Holidays",
    href: "/admin/holidays",
    minRole: "admin",
    // P7-35. Admin-only to EDIT — but what it produces is read by everybody, on
    // the shared calendar on the home page. That is why there is no member-level
    // entry for it: there is nothing to navigate to, the result is already
    // where they are looking.
    enabled: true,
    icon: "calendar-off",
  },
  {
    label: "Events",
    href: "/admin/events",
    minRole: "admin",
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
    minRole: "admin",
    // P7-37. Company-wide rules, read by everybody and written by nobody else.
    // Sits with Holidays for the same reason: both are policy an admin sets
    // once and the whole app then obeys silently.
    enabled: true,
    icon: "settings",
  },
  {
    label: "Audit trail",
    href: "/admin/audit",
    minRole: "admin",
    // P0-09. The table has been written to since Phase 0 by every server action
    // and by a dozen SQL functions; this is the first thing that reads it.
    //
    // LAST in the group, and that is the ordering rule rather than an accident:
    // everything above it is a screen you change something on, and this is the
    // one you open to find out what somebody already changed.
    enabled: true,
    icon: "history",
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

const ROLE_ORDER: Role[] = ["member", "team_leader", "manager", "admin"];

/**
 * Nav filtering is presentation, not authorization. Hiding a link protects
 * nobody — every route re-checks through lib/auth/authorization.ts, and RLS
 * re-checks under that.
 */
export function roleAllows(role: Role, required: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}

export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => roleAllows(role, item.minRole)).map((item) => {
    if (!item.children) return item;

    // A child with no `minRole` inherits the parent's, which the filter above
    // has already cleared — so only the ones that RAISE the floor are re-checked.
    const children = item.children.filter(
      (child) => !child.minRole || roleAllows(role, child.minRole),
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
  { label: "Work", hrefs: ["/dashboard", "/requests", "/inbox"] },
  // `/timesheet/team` is NOT here any more — it is a child of `/timesheet` and
  // is reached through it. Listing a child href beside its parent is what put
  // them side by side in the rail in the first place.
  { label: "Time", hrefs: ["/dtr", "/approvals", "/timesheet"] },
  { label: "Manage", hrefs: ["/forms", "/reports"] },
  {
    label: "Admin",
    hrefs: [
      "/admin/users",
      "/admin/holidays",
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
export function groupedNavItems(role: Role): { group: NavGroup; items: NavItem[] }[] {
  const visible = visibleNavItems(role);

  return NAV_GROUPS.map((group) => ({
    group,
    items: group.hrefs
      .map((href) => visible.find((item) => item.href === href))
      .filter((item): item is NavItem => Boolean(item)),
  })).filter(({ items }) => items.length > 0);
}

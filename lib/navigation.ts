import type { Role } from "@/lib/auth/authorization";

/**
 * The six modules behind one login (docs/01-updated-workflow.md §0).
 *
 * Modules that are not built yet still render, disabled — "so the shape is
 * visible" (P0-07). A nav that grows a new item every phase reads as an
 * unfinished tool; a nav that is complete on day one and fills in reads as a
 * plan. It also stops anyone quietly reinventing a module in the wrong place.
 */

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
};

export type NavIconName =
  | "dashboard"
  | "clock"
  | "check"
  | "form"
  | "inbox-stack"
  | "tasks"
  | "timesheet"
  | "inbox"
  | "users";

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
    label: "Tasks",
    href: "/tasks",
    minRole: "member",
    enabled: true,
    icon: "tasks",
  },
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
    // Enabled with P6-02/P6-03. The route exists and the table behind it does
    // too; leaving it disabled would now be the nav lying in the other
    // direction, which is worse than the placeholder it replaced.
    enabled: true,
    icon: "timesheet",
  },
  {
    // P6-05 / slice E1. Team leaders and up: this is where submitted weeks are
    // approved, and it is where the submit notification's link_path points
    // (`20260818110000_p7_05_timesheet_weeks.sql:339`). A member has nobody to
    // review, and the page says so rather than 404ing if they reach it.
    label: "Team week",
    href: "/timesheet/team",
    minRole: "team_leader",
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
];

const ROLE_ORDER: Role[] = ["member", "team_leader", "manager", "admin"];

/**
 * Nav filtering is presentation, not authorization. Hiding a link protects
 * nobody — every route re-checks through lib/auth/authorization.ts, and RLS
 * re-checks under that.
 */
export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(item.minRole));
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
  { label: "Work", hrefs: ["/dashboard", "/requests", "/tasks", "/inbox"] },
  { label: "Time", hrefs: ["/dtr", "/approvals", "/timesheet", "/timesheet/team"] },
  { label: "Manage", hrefs: ["/forms"] },
  { label: "Admin", hrefs: ["/admin/users"], pinBottom: true },
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

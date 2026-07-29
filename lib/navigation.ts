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
    enabled: false,
    phase: "Phase 3",
    icon: "tasks",
  },
  {
    label: "DTR",
    href: "/dtr",
    minRole: "member",
    enabled: false,
    phase: "Phase 5",
    icon: "clock",
  },
  {
    label: "Approvals",
    href: "/approvals",
    minRole: "member",
    enabled: false,
    phase: "Phase 5",
    icon: "check",
  },
  {
    label: "Timesheet",
    href: "/timesheet",
    minRole: "member",
    enabled: false,
    phase: "Phase 6",
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

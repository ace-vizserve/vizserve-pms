"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { NavGroup, NavItem } from "@/lib/navigation";
import { NavIcon } from "./nav-icon";
import { NavUser } from "./nav-user";

export type SidebarSection = { group: NavGroup; items: NavItem[] };

/**
 * The application sidebar.
 *
 * The upstream template reads a hardcoded module-level nav object, because it
 * has no authentication. Ours is handed sections already filtered by role in
 * the server layout — that filtering is presentation only, since every route
 * re-checks through lib/auth/authorization.ts and RLS re-checks beneath that.
 *
 * Modules that are not built yet still render, disabled, with their phase. A
 * nav that grows an item every phase reads as an unfinished tool; one that is
 * complete on day one and fills in reads as a plan.
 */
export function AppSidebar({
  sections,
  user,
  badges,
}: {
  sections: SidebarSection[];
  user: { fullName: string; email: string; role: string; departments: string[] };
  /**
   * Counts to hang off nav items, keyed by href — `{ "/inbox": "99+" }`.
   *
   * Pre-formatted strings rather than numbers: the cap ("99+") is a
   * presentation decision that belongs with the thing that knows the real
   * count, and a sidebar badge is the wrong place to be doing arithmetic.
   */
  badges?: Record<string, string | null>;
}) {
  const pathname = usePathname();

  const flow = sections.filter(({ group }) => !group.pinBottom);
  const pinned = sections.filter(({ group }) => group.pinBottom);

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                V
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">VizServe PMS</span>
                <span className="truncate text-xs text-muted-foreground">Operations</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {flow.map((section) => (
          <NavSection
            key={section.group.label}
            section={section}
            pathname={pathname}
            badges={badges}
          />
        ))}

        {pinned.map((section) => (
          <NavSection
            key={section.group.label}
            section={section}
            pathname={pathname}
            badges={badges}
            className="mt-auto"
          />
        ))}
      </SidebarContent>

      <SidebarFooter>
        <NavUser {...user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function NavSection({
  section,
  pathname,
  badges,
  className,
}: {
  section: SidebarSection;
  pathname: string;
  badges?: Record<string, string | null>;
  className?: string;
}) {
  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel>{section.group.label}</SidebarGroupLabel>
      <SidebarMenu>
        {section.items.map((item) => {
          // startsWith, not equality: a detail route like /requests/<id> must
          // still light up its parent. The template uses exact matching and its
          // nested routes silently fail to highlight.
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

          if (!item.enabled) {
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  disabled
                  tooltip={`${item.label} arrives in ${item.phase}`}
                  className="cursor-not-allowed opacity-60"
                >
                  <NavIcon name={item.icon} />
                  <span className="flex-1">{item.label}</span>
                  <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                    {item.phase}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          }

          const badge = badges?.[item.href];

          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                isActive={isActive}
                tooltip={item.label}
                render={<Link href={item.href} />}
              >
                <NavIcon name={item.icon} />
                <span>{item.label}</span>
              </SidebarMenuButton>

              {/* Sibling of the button, not a child: SidebarMenuBadge is
                  absolutely positioned and keys off the button as its peer.
                  Nested inside, it would sit in the flex row and push the
                  label. */}
              {badge ? (
                <SidebarMenuBadge className="bg-primary/10 text-primary">
                  {badge}
                  {/* The number alone reads as decoration to a screen reader,
                      which announces the link as "Inbox 12". */}
                  <span className="sr-only"> unread</span>
                </SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

"use client";

import Image from "next/image";
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
    <Sidebar variant="sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" />}
              className="h-13 border bg-card grade-raised shadow-raised hover:bg-card"
            >
              {/*
                The real mark, not the letterform placeholder that used to sit
                here — the same objection brand-lockup.tsx already records for
                the client-facing pages.

                The tile is `bg-white` and deliberately does NOT flip with the
                theme: this is the BLUE logo, so it needs a light ground in both
                modes. The white-on-brand-surface asset is the other half of the
                same rule, and BrandLockup uses that one.

                `alt=""` because the wordmark beside it already names the thing;
                a screen reader announcing "VizServe VizServe PMS" is worse than
                one that just reads the text.
              */}
              <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md border border-border bg-white p-1 shadow-raised">
                <Image
                  src="/assets/vizserve-logo-blue.png"
                  alt=""
                  width={130}
                  height={130}
                  sizes="32px"
                  priority
                  className="h-full w-auto"
                />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold tracking-[-0.014em]">
                  VizServe PMS
                </span>
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

"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChevronDown, ChevronRight } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { NavGroup, NavItem } from "@/lib/navigation";
import { NavIcon } from "./nav-icon";
import { NavProjects, type ProjectFolder } from "./nav-projects";
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
  folders = [],
  canManageLists = false,
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
  /**
   * The project tree — departments as folders, their lists inside.
   *
   * Already scoped by RLS in the layout, so a member gets their own department
   * and an admin gets everything from the same query.
   */
  folders?: ProjectFolder[];
  /** Whether `/tasks/lists` is reachable for this person — it is team_leader+. */
  canManageLists?: boolean;
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

        {/* Between the flow and the pinned sections: the modules are what you
            DO, the projects are where the work lives, and Admin stays at the
            foot. */}
        <NavProjects folders={folders} canManageLists={canManageLists} />

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
    /*
     * COLLAPSIBLE AT THE GROUP LEVEL, per the shadcn pattern: the Collapsible
     * wraps the whole SidebarGroup and the label IS the trigger.
     *
     * ⚠️ THE CHEVRON KEYS OFF `aria-expanded`, NOT `data-open`. The documented
     * sample uses `group-data-open/collapsible:rotate-180`, and on this build
     * that class never fires — Base UI's trigger emits `data-panel-open` and
     * `aria-expanded`, and there is no `data-open` anywhere in the rendered
     * markup. A dead Tailwind variant is invisible: the group would collapse
     * correctly and the arrow would simply never turn. `aria-expanded` is what
     * `status-group.tsx` already uses and it is the one that is guaranteed,
     * because it is the accessibility contract rather than an implementation
     * detail.
     *
     * `group/nav`, named — the sidebar nests collapsibles (the project folders
     * are inside one of these), and an unnamed group would rotate every chevron
     * in the rail at once.
     */
    <Collapsible defaultOpen render={<SidebarGroup className={className} />}>
      {/*
        ⚠️ `group/nav` GOES ON THE TRIGGER, not on the Collapsible root.
        
        Tailwind compiles `group-aria-expanded/nav:rotate-180` to
        `:where(.group\/nav)[aria-expanded="true"] *` — one element carrying BOTH
        the group class and the attribute. `aria-expanded` is set on the trigger,
        so putting the class on the wrapper produces a selector that can never
        match: the group collapses correctly and the arrow silently never turns.
        `status-group.tsx` gets this right and is the working precedent.
      */}
      <SidebarGroupLabel
        render={<CollapsibleTrigger />}
        className="group/nav cursor-pointer hover:text-foreground"
      >
        {section.group.label}
        <ChevronDown
          aria-hidden
          className="ml-auto size-4 shrink-0 transition-transform group-aria-expanded/nav:rotate-180"
        />
      </SidebarGroupLabel>

      <CollapsibleContent render={<SidebarGroupContent />}>
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

          /*
           * A PARENT WITH CHILDREN IS A DISCLOSURE, NOT A LINK.
           *
           * `/timesheet/team` used to sit beside `/timesheet` as a sibling while
           * being its child in the URL — and because the active check is
           * `startsWith`, standing on the team week lit both rows and the rail
           * claimed you were in two places at once. Nesting fixes the structure;
           * `activeChild` below fixes the highlight.
           */
          if (item.children) {
            // MOST SPECIFIC WINS. `/tasks/board` matches both "/tasks" and
            // "/tasks/board"; the longer href is the one you are actually on.
            // Sorting rather than special-casing the index child means a third
            // level would fall out correctly without touching this.
            const activeChild = item.children
              .filter(
                (child) => pathname === child.href || pathname.startsWith(`${child.href}/`),
              )
              .sort((a, b) => b.href.length - a.href.length)[0];

            return (
              <Collapsible
                key={item.href}
                // Open when you are inside it. A tree that collapses the branch
                // you are standing on loses you on every navigation.
                defaultOpen={Boolean(activeChild)}
                render={<SidebarMenuItem />}
              >
                <CollapsibleTrigger
                  render={
                    // `group/sub` on the BUTTON, which is what carries
                    // `aria-expanded` — the compiled selector needs the class and
                    // the attribute on one element. See the note on the group
                    // label above.
                    <SidebarMenuButton
                      tooltip={item.label}
                      // Marked when a child is active, because the parent row is
                      // the only thing visible once the branch is collapsed.
                      isActive={Boolean(activeChild)}
                      className="group/sub"
                    >
                      <NavIcon name={item.icon} />
                      <span className="flex-1 truncate">{item.label}</span>
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/sub:rotate-90"
                      />
                    </SidebarMenuButton>
                  }
                />

                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.children.map((child) => (
                      <SidebarMenuSubItem key={child.href}>
                        <SidebarMenuSubButton
                          isActive={child.href === activeChild?.href}
                          render={<Link href={child.href} />}
                        >
                          <span className="truncate">{child.label}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </Collapsible>
            );
          }

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
      </CollapsibleContent>
    </Collapsible>
  );
}

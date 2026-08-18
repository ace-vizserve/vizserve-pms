"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Folder, ListChecks, Plus } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * The project tree — departments as folders, their lists inside.
 *
 * Amier's reference is a ClickUp sidebar: spaces that collapse, each holding the
 * lists people actually work out of, so "where does this task live" is answered
 * by navigating rather than by remembering a filter. THIS APP ALREADY HAD BOTH
 * HALVES and neither was reachable from the nav: `vizserve_pms_lists` has
 * carried a `department_id` since P2-06, `/tasks` has read `?list=` since P3-14,
 * and the only way to reach either was the filter panel on the tasks page.
 *
 * SO THIS INVENTS NO NEW CONCEPT. A department is the folder and a list is the
 * project, because that is the shape the data already has. Adding a separate
 * "space" or "folder" table to match the reference exactly would be a third
 * grouping beside two that already exist, and the third one is the one nobody
 * maintains.
 *
 * D21 is why the shape is borrowed at all: ClickUp is a feature reference, and
 * what carries over is the SHAPE of things the team already knows how to use.
 *
 * Scoped by RLS, not by a filter here. `vizserve_pms_lists` returns what the
 * caller may see, so a member gets their own department's folders and an admin
 * gets everything — from the same query, with no role check in this component.
 */

export type ProjectFolder = {
  departmentId: string;
  departmentName: string;
  lists: { id: string; name: string; openTasks: number }[];
};

export function NavProjects({ folders }: { folders: ProjectFolder[] }) {
  const pathname = usePathname();
  const params = useSearchParams();

  // The list currently being filtered on, so the tree can mark it. Read from the
  // query string rather than the path because `?list=` IS the route — there is
  // no `/tasks/lists/<id>` page and inventing one would be a second way to say
  // the same thing.
  const activeList = pathname === "/tasks" ? params.get("list") : null;

  /*
   * The group renders even with NOTHING IN IT, and that is the point.
   *
   * There are no lists in this system yet, so an early cut of this returned null
   * and the whole feature was invisible — including the only route to creating
   * the first list. A tree that appears once somebody has already found the page
   * that fills it is a tree nobody finds.
   */
  return (
    // The group collapses like every other one in the rail, and the folders
    // inside collapse independently — two levels, which is the shape the
    // reference has. Both key off `aria-expanded` rather than `data-open`; see
    // the note in app-sidebar.tsx for why the documented class does not fire.
    <Collapsible defaultOpen render={<SidebarGroup />}>
      {/* The group class rides the TRIGGER — see the note in app-sidebar.tsx. */}
      <SidebarGroupLabel
        render={<CollapsibleTrigger />}
        className="group/nav cursor-pointer hover:text-foreground"
      >
        Projects
        <ChevronDown
          aria-hidden
          className="ml-auto size-4 shrink-0 transition-transform group-aria-expanded/nav:rotate-180"
        />
      </SidebarGroupLabel>

      <CollapsibleContent render={<SidebarGroupContent />}>
      <SidebarMenu>
        {folders.map((folder) => {
          // Open when something inside it is being looked at. A tree that
          // collapses the folder you are standing in is a tree that loses you on
          // every navigation.
          const holdsActive = folder.lists.some((list) => list.id === activeList);

          return (
            <Collapsible
              key={folder.departmentId}
              defaultOpen={holdsActive}
              render={<SidebarMenuItem />}
            >
              <CollapsibleTrigger
                render={
                  // `group/folder` on the BUTTON, which is what carries
                  // `aria-expanded` — same rule as the group label above, and
                  // named so one open folder does not rotate every chevron.
                  <SidebarMenuButton
                    tooltip={folder.departmentName}
                    className="group/folder"
                  >
                    <Folder />
                    <span className="flex-1 truncate">{folder.departmentName}</span>
                    <ChevronRight
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/folder:rotate-90"
                    />
                  </SidebarMenuButton>
                }
              />

              <CollapsibleContent>
                <SidebarMenuSub>
                  {folder.lists.map((list) => (
                    <SidebarMenuSubItem key={list.id}>
                      <SidebarMenuSubButton
                        isActive={list.id === activeList}
                        render={<Link href={`/tasks?list=${list.id}`} />}
                      >
                        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{list.name}</span>
                      </SidebarMenuSubButton>

                      {/* Live work only, and hidden at zero. A permanent 0 beside
                          every list teaches people to stop reading the column —
                          the same rule the QA tile on the dashboard follows. */}
                      {list.openTasks > 0 ? (
                        <SidebarMenuBadge className="tabular-nums">
                          {list.openTasks}
                          <span className="sr-only"> open tasks</span>
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuSubItem>
                  ))}

                  {folder.lists.length === 0 ? (
                    <SidebarMenuSubItem>
                      <span className={cn("block px-2 py-1 text-2xs text-muted-foreground")}>
                        No lists yet
                      </span>
                    </SidebarMenuSubItem>
                  ) : null}
                </SidebarMenuSub>
              </CollapsibleContent>
            </Collapsible>
          );
        })}

        {/* The `+` from the reference. It is the last row rather than a control
            on the group heading, because at zero folders it is the ONLY row —
            and a heading-mounted button on an empty group is an affordance
            floating over nothing.

            `/tasks/lists` is where lists are created and archived; it already
            exists and enforces its own department scope, so this is a link to a
            screen rather than a second way to make one. */}
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={folders.length === 0 ? "Create your first list" : "Manage lists"}
            className="text-muted-foreground"
            render={<Link href="/tasks/lists" />}
          >
            <Plus />
            <span>{folders.length === 0 ? "Create a list" : "Manage lists"}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      </CollapsibleContent>
    </Collapsible>
  );
}

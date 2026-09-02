"use client";

import { useState } from "react";
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
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * The project tree — Department → Folder → List, collapsing at every level.
 *
 * Amier's reference is a ClickUp sidebar, and this now matches its shape rather
 * than approximating it: a Space that holds Folders, Folders that hold Lists,
 * and Lists that hold the work. Folderless lists hang directly off the
 * department, which is ClickUp's own rule and not a special case invented here.
 *
 * ⚠️ THIS FILE USED TO ARGUE AGAINST THE FOLDER TABLE. The comment said "a
 * department is the folder and a list is the project, because that is the shape
 * the data already has", and that adding one "would be a third grouping beside
 * two that already exist, and the third one is the one nobody maintains".
 *
 * It did not survive an example. The folder people wanted was "VIZSERVE
 * PROJECTS", holding a list "VIZSERVE WEBSITE" — and VIZSERVE PROJECTS is not a
 * department. Departments are VizBytes / VizAssists / VizBooks / VizMedia: a
 * fixed, admin-managed list of WHO DOES THE WORK. Folders are how a team groups
 * WHAT THE WORK IS FOR, and they are made and renamed constantly. Collapsing the
 * two meant the grouping people actually wanted could not be expressed at all.
 * `vizserve_pms_task_groups` (P7-18) is the correction.
 *
 * D21 is why the shape is borrowed at all: ClickUp is a feature reference, and
 * what carries over is the SHAPE of things the team already knows how to use.
 *
 * Scoped by RLS, not by a filter here. Every query behind this returns what the
 * caller may see, so a member gets their own department and an admin gets
 * everything — from the same queries, with no role check in this component.
 */

export type ProjectList = {
  id: string;
  name: string;
  openTasks: number;
  /** P7-26. Client requests waiting on Gate 1 that will land in this list. */
  pendingRequests: number;
};

export type ProjectFolder = {
  id: string;
  name: string;
  /**
   * The reserved "Client Requests" folder.
   *
   * Still special — it cannot be renamed, moved, archived while forms file into
   * it, or deleted — so it gets no pencil. Since P7-25 it DOES take hand-made
   * lists, so it gets the `+` like every other folder.
   */
  isSystem: boolean;
  lists: ProjectList[];
  /** Rolled up from `lists`, so a collapsed folder still says how much is in it. */
  openTasks: number;
  /** Rolled up the same way. Client Requests is where this is usually non-zero. */
  pendingRequests: number;
};

/**
 * A department.
 *
 * NAMED "SPACE" RATHER THAN "FOLDER" since P7-18, and the rename is not
 * cosmetic: "folder" now means a row in a real table, and one word meaning two
 * things inside one component is how the wrong level gets edited six months
 * later. ClickUp calls this level a Space, which is also what the migration's
 * own diagram calls it.
 */
export type ProjectSpace = {
  departmentId: string;
  departmentName: string;
  /** Folderless lists — ClickUp's term. Rendered above the folders. */
  lists: ProjectList[];
  folders: ProjectFolder[];
};

export function NavProjects({
  spaces,
  canManageLists,
}: {
  spaces: ProjectSpace[];
  /**
   * `/tasks/lists` calls `requireDepartmentShape()` and renders the forbidden
   * page for anybody else.
   *
   * ⚠️ P8-01c CHANGED WHAT "ANYBODY ELSE" MEANS. That gate was
   * `requireRole("team_leader")`; it now also admits a DEPARTMENT ADMIN of any
   * rank, so the caller passes `canShapeAnyDepartment(context)` rather than a
   * rank test. Leaving a rank test here would have hidden "Create a list" from
   * exactly the person the Admin tick was built for.
   *
   * ⚠️ THIS ROW WAS SHIPPED UNGATED and sent every member to that error — the
   * feature was meant to make lists discoverable and instead made a dead end
   * discoverable. Hiding a link protects nobody (the page re-checks, and RLS
   * re-checks under it); what it does is stop offering a door that does not
   * open.
   */
  canManageLists: boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  // The list currently being filtered on, so the tree can mark it. Read from the
  // query string rather than the path because `?list=` IS the route — there is
  // no `/tasks/lists/<id>` page and inventing one would be a second way to say
  // the same thing.
  //
  // BOTH VIEWS, not just the list. Now that List and Board are two shapes of the
  // same list rather than two separate destinations, `/tasks/board?list=<id>` is
  // as much "inside that list" as `/tasks?list=<id>` is — and testing only the
  // bare route would collapse the tree the moment somebody switched to the
  // board, and light "All tasks" while they were plainly inside one.
  //
  // `/tasks/lists` is excluded: it is the management screen, not a view of a
  // list, and it never carries `?list=`.
  const onTaskView = pathname === "/tasks" || pathname === "/tasks/board";
  const activeList = onTaskView ? params.get("list") : null;

  /*
   * ⚠️ THIS GROUP NO LONGER RETURNS NULL, and removing that early exit was
   * REQUIRED rather than tidy.
   *
   * It used to read `if (spaces.length === 0 && !canManageLists) return null`,
   * on the reasoning that an empty tree is a heading over nothing for a member
   * who cannot create lists. That was true while a separate Tasks group carried
   * `/tasks`. It was deleted (lib/navigation.ts), so this group is now the ONLY
   * route to the task list — and a member in a department with no lists yet
   * would have had no way to reach their own work at all.
   *
   * "All tasks" below is always rendered, so the group always has a row worth
   * showing. The "Create a list" row is still gated on `canManageLists`,
   * because that screen genuinely refuses a member.
   */

  return (
    // The group collapses like every other one in the rail, and everything
    // inside collapses independently. All three chevrons key off
    // `aria-expanded` rather than `data-open`; see the note in app-sidebar.tsx
    // for why the documented class does not fire.
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
          {/*
            EVERYTHING, ABOVE THE TREE.

            The Tasks nav group used to hold this route and was deleted for
            being a second heading over the same work (see lib/navigation.ts).
            The route itself is not redundant: the tree can only ever say "one
            list", and "what is on my plate across all of them" is the question
            most people open the app to answer.

            Marked active only on the BARE route. `/tasks?list=<id>` is a list
            in the tree below and lighting both would be the two-places-at-once
            bug that nesting the timesheet routes fixed.
          */}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={onTaskView && !activeList}
              tooltip="Every task you can see"
              // Same rule as a list row: keep the shape, drop the list.
              render={<Link href={pathname === "/tasks/board" ? "/tasks/board" : "/tasks"} />}
            >
              <ListChecks />
              <span>All tasks</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {spaces.map((space) => (
            <SpaceNode
              key={space.departmentId}
              space={space}
              activeList={activeList}
              canManageLists={canManageLists}
            />
          ))}

          {/* The `+` from the reference. It is the last row rather than a control
              on the group heading, because at zero spaces it is the ONLY row —
              and a heading-mounted button on an empty group is an affordance
              floating over nothing.

              `/tasks/lists` is where folders and lists are created and archived;
              it already exists and enforces its own department scope, so this is
              a link to a screen rather than a second way to make one. */}
          {canManageLists ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={spaces.length === 0 ? "Create your first list" : "Manage folders and lists"}
                className="text-muted-foreground"
                render={<Link href="/tasks/lists" />}
              >
                <Plus />
                <span>{spaces.length === 0 ? "Create a list" : "Manage lists"}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Open when something inside is being looked at.
 *
 * ⚠️ CONTROLLED, NOT `defaultOpen`, AND THAT IS A BUG FIX. `defaultOpen` applies
 * only at mount, and the app shell does not remount across client navigations —
 * so navigating to a list from the filter panel on `/tasks` left the department
 * holding it shut. That was already wrong with two levels; with three you can be
 * looking at a list whose folder AND whose department are both collapsed.
 *
 * Forced open on arrival, never forced shut: an explicit collapse by the user
 * sticks until they navigate into it again.
 */
function useHoldsActive(holds: boolean) {
  const [open, setOpen] = useState(holds);

  /*
   * Adjusted DURING RENDER, not in an effect.
   *
   * The effect version is the obvious one and it is wrong twice: React's own
   * lint refuses it ("calling setState synchronously within an effect can
   * trigger cascading renders"), and it renders the closed state once before
   * correcting it, which is a visible flicker on every navigation. Comparing
   * against the previous value during render is the pattern React documents for
   * exactly this — state that usually belongs to the user but has to yield to a
   * prop when the prop changes.
   */
  const [wasHolding, setWasHolding] = useState(holds);

  if (holds !== wasHolding) {
    setWasHolding(holds);
    if (holds) setOpen(true);
  }

  return [open, setOpen] as const;
}

function SpaceNode({
  space,
  activeList,
  canManageLists,
}: {
  space: ProjectSpace;
  activeList: string | null;
  canManageLists: boolean;
}) {
  const holds =
    space.lists.some((list) => list.id === activeList) ||
    space.folders.some((folder) => folder.lists.some((list) => list.id === activeList));

  const [open, setOpen] = useHoldsActive(holds);

  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuItem />}>
      <CollapsibleTrigger
        render={
          // `group/space` on the BUTTON, which is what carries `aria-expanded` —
          // same rule as the group label above, and named so one open department
          // does not rotate every chevron in the rail.
          <SidebarMenuButton tooltip={space.departmentName} className="group/space">
            <Folder />
            <span className="flex-1 truncate">{space.departmentName}</span>
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/space:rotate-90"
            />
          </SidebarMenuButton>
        }
      />

      <CollapsibleContent>
        <SidebarMenuSub>
          {/* Folderless lists first — see the note in layout.tsx. */}
          {space.lists.map((list) => (
            <ListRow key={list.id} list={list} activeList={activeList} />
          ))}

          {space.folders.map((folder) => (
            <FolderNode
              key={folder.id}
              folder={folder}
              activeList={activeList}
              canManageLists={canManageLists}
            />
          ))}

          {space.lists.length === 0 && space.folders.length === 0 ? (
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
}

function FolderNode({
  folder,
  activeList,
  canManageLists,
}: {
  folder: ProjectFolder;
  activeList: string | null;
  canManageLists: boolean;
}) {
  const holds = folder.lists.some((list) => list.id === activeList);
  const [open, setOpen] = useHoldsActive(holds);

  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuSubItem />}>
      <CollapsibleTrigger
        render={
          /*
           * ⚠️ `render={<button type="button" />}` IS LOAD-BEARING.
           *
           * `SidebarMenuSubButton` defaults to `<a>` (sidebar.tsx), unlike
           * `SidebarMenuButton` which defaults to `<button>`. Without this the
           * trigger renders as `<a aria-expanded="true">` with no href: not
           * keyboard focusable, wrong role, and silently so — it still opens on
           * a mouse click, which is exactly how this would ship unnoticed.
           *
           * `pr-9` by hand because the `pr-8` action reservation in
           * `sidebarMenuButtonVariants` is scoped to `group/menu-item`, and a
           * folder row is a `menu-sub-item` — so it never fires here.
           */
          <SidebarMenuSubButton
            render={<button type="button" />}
            className="group/folder w-full pr-9 text-left"
          >
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded/folder:rotate-90"
            />
            {/* Uppercase is CSS, never stored. Storing SHOUTING would leak into
                /tasks/lists, into the folder picker, and into the database's own
                error sentences — and a screen reader reads the underlying text,
                so the accessible name stays as typed. */}
            <span className="truncate text-2xs font-semibold uppercase tracking-wider">
              {folder.name}
            </span>
            <FolderCounts
              pending={folder.pendingRequests}
              open={folder.openTasks}
              hideOpenWhenExpanded
            />
          </SidebarMenuSubButton>
        }
      />

      {/*
       * The `+` from the screenshot, on EVERY folder.
       *
       * ⚠️ THE RESERVED FOLDER USED TO GET NONE. The old note read: "its lists
       * are created by a trigger when a form is made, and it refuses a hand-made
       * one — so the control could only ever produce an error message." True
       * until P7-25 relaxed `vizserve_pms_lists_group_guard`. A folder is a
       * folder now: every one of them holds lists and every one of them can be
       * added to.
       *
       * `showOnHover` is NOT passed and must not be: it keys on
       * `group-hover/menu-item`, and `group/menu-item` only exists on
       * `SidebarMenuItem`. A folder row is a `SidebarMenuSubItem`, which carries
       * `group/menu-sub-item` — so the prop is silently dead here and the hover
       * classes are supplied by hand. `top-0.5 size-5` because the built-in
       * `top-1.5` is sized for an h-10 button and this row is h-7.
       *
       * There is no `…` beside it. It would link to `/tasks/lists`, which is
       * where this `+` already goes — two controls to the same screen is one
       * more than the screen deserves.
       */}
      {canManageLists ? (
        <SidebarMenuAction
          className="top-0.5 size-5 opacity-0 group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100"
          render={<Link href="/tasks/lists" />}
        >
          <Plus />
          <span className="sr-only">Add a list to {folder.name}</span>
        </SidebarMenuAction>
      ) : null}

      <CollapsibleContent>
        <SidebarMenuSub>
          {folder.lists.map((list) => (
            <ListRow key={list.id} list={list} activeList={activeList} />
          ))}

          {folder.lists.length === 0 ? (
            <SidebarMenuSubItem>
              <span className="block px-2 py-1 text-2xs text-muted-foreground">Empty</span>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ListRow({ list, activeList }: { list: ProjectList; activeList: string | null }) {
  const pathname = usePathname();

  /*
   * THE VIEW SURVIVES THE JUMP.
   *
   * A list is a place and List/Board are two shapes of it, so somebody working
   * on the board who clicks the next list expects the next board — being thrown
   * back to the list view every time is the same complaint as a filter that
   * resets, and it is why `TaskToolbar` carries the query string in the other
   * direction.
   *
   * Anywhere else in the app, the list view is the right landing.
   */
  const base = pathname === "/tasks/board" ? "/tasks/board" : "/tasks";

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={list.id === activeList}
        render={<Link href={`${base}?list=${list.id}`} />}
      >
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{list.name}</span>
        <FolderCounts pending={list.pendingRequests} open={list.openTasks} />
      </SidebarMenuSubButton>

    </SidebarMenuSubItem>
  );
}

/**
 * The two counts a folder or list carries, rendered INSIDE the row.
 *
 * ⚠️ THESE USED TO BE `SidebarMenuBadge`, WHICH IS `absolute right-1` — and so
 * is `SidebarMenuAction`, the `+`. They shared one slot. That was survivable
 * while the `+` appeared on hover only and the badge hid itself on hover to get
 * out of the way, and it stopped being survivable the moment P7-25 put a `+` on
 * every folder including the reserved one: the count and the button drew on top
 * of each other, and on a sub-row the badge had no `top` to key off at all
 * (`SidebarMenuBadge`'s offsets are `peer-data-[size=*]/menu-button:` classes,
 * and a sub-button carries no `data-size`), so it floated over the label.
 *
 * Inline in the flex row removes the whole class of bug: the counts take part in
 * the layout, `ml-auto` puts them at the end, and the trigger's own `pr-9`
 * keeps them clear of the `+`. Nothing has to hide to make room for anything.
 */
function FolderCounts({
  pending,
  open,
  hideOpenWhenExpanded = false,
}: {
  pending: number;
  open: number;
  /**
   * On a FOLDER, the open-task total is the sum of the rows revealed directly
   * beneath it, so it is worth saying only while shut. The pending count is not
   * — nothing below repeats it, because a pending request has no list row of
   * its own to appear in.
   */
  hideOpenWhenExpanded?: boolean;
}) {
  if (pending === 0 && open === 0) return null;

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-2xs tabular-nums">
      {/* P7-26 — waiting on a decision, and deliberately NOT the open-task count
          in a different colour. "2 new" carries the meaning in words, which is
          the standing rule: a reader who cannot separate the accent from the
          muted tone still gets the fact. */}
      {pending > 0 ? (
        <span className="rounded-full bg-info/15 px-1.5 font-semibold text-info">
          {pending} new
          <span className="sr-only"> requests awaiting approval</span>
        </span>
      ) : null}

      {/* Live work only, and hidden at zero. A permanent 0 beside every list
          teaches people to stop reading the column — the same rule the QA tile
          on the dashboard follows. */}
      {open > 0 ? (
        <span
          className={cn(
            "font-semibold text-muted-foreground",
            hideOpenWhenExpanded && "group-aria-expanded/folder:hidden",
          )}
        >
          {open}
          <span className="sr-only"> open tasks</span>
        </span>
      ) : null}
    </span>
  );
}

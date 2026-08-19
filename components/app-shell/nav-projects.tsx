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
  SidebarMenuBadge,
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

export type ProjectList = { id: string; name: string; openTasks: number };

export type ProjectFolder = {
  id: string;
  name: string;
  /** The reserved "Client Requests" folder. Gets no controls — see below. */
  isSystem: boolean;
  lists: ProjectList[];
  /** Rolled up from `lists`, so a collapsed folder still says how much is in it. */
  openTasks: number;
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
   * `/tasks/lists` calls `requireRole("team_leader")` and renders the forbidden
   * page for anybody else.
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
  const activeList = pathname === "/tasks" ? params.get("list") : null;

  /*
   * The group renders with nothing but its "Create a list" row, and that is the
   * point: an early cut returned null while no lists existed, which made the
   * whole feature invisible including the only route to creating the first one.
   *
   * But a member cannot create lists, so for THEM an empty tree is a heading
   * over nothing. Nothing to navigate to and nothing to do about it.
   */
  if (spaces.length === 0 && !canManageLists) return null;

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
          </SidebarMenuSubButton>
        }
      />

      {/* Hidden while open, because the children below already say it, and while
          hovered, because the `+` occupies the same slot.

          `peer-*` rather than `group-*`: the badge is a SIBLING of the trigger,
          and `group-aria-expanded` compiles to an ancestor selector that can
          never match a sibling. `SidebarMenuBadge` already uses
          `peer-hover/menu-button:`, so the mechanism is the established one. */}
      {folder.openTasks > 0 ? (
        <SidebarMenuBadge className="top-0.5 tabular-nums peer-aria-expanded/menu-button:hidden group-hover/menu-sub-item:hidden">
          {folder.openTasks}
          <span className="sr-only"> open tasks</span>
        </SidebarMenuBadge>
      ) : null}

      {/*
       * The `+` from the screenshot. THE RESERVED FOLDER GETS NONE: its lists
       * are created by a trigger when a form is made, and it refuses a hand-made
       * one — so the control could only ever produce an error message.
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
      {canManageLists && !folder.isSystem ? (
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
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={list.id === activeList}
        render={<Link href={`/tasks?list=${list.id}`} />}
      >
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{list.name}</span>
      </SidebarMenuSubButton>

      {/* Live work only, and hidden at zero. A permanent 0 beside every list
          teaches people to stop reading the column — the same rule the QA tile
          on the dashboard follows. */}
      {list.openTasks > 0 ? (
        <SidebarMenuBadge className="tabular-nums">
          {list.openTasks}
          <span className="sr-only"> open tasks</span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuSubItem>
  );
}

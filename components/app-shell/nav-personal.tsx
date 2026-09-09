"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Folder, ListChecks, MoreHorizontal, Plus } from "lucide-react";

import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

import { savePersonalList } from "@/app/(app)/tasks/actions";
import { LinkPending } from "./link-pending";

/**
 * P11-06 — the reader's own lists, and nobody else's.
 *
 * Amier, 8 Sep: a "Personal lists" section in the rail, after Projects, for the
 * tasks somebody keeps for themselves.
 *
 * ⚠️ A SEPARATE GROUP, NOT A FOLDER INSIDE THE DEPARTMENT. The obvious cheap
 * version is a "Personal" folder under your own space in the Projects tree, and
 * it is wrong on both halves: a folder is a department object visible to the
 * whole team (P7-18), and the tree above is explicitly where the DEPARTMENT'S
 * work lives. Personal work is not filed under the department's shape, it sits
 * beside it — which is also what makes the heading self-explanatory. Nobody has
 * to be told that the things under "Personal lists" are private.
 *
 * ⚠️ THE GROUP HOLDS ONE FIXED NODE — "Personal Space" — AND THE LISTS HANG OFF
 * IT. The first version rendered them flat, one row per list under the heading,
 * and Amier corrected it on 8 Sep: it should be a space you add lists INTO, the
 * way VizBytes is in the tree above. The space is a constant in this file rather
 * than a row in any table; see `SPACE_NAME` for why that is the whole of it.
 *
 * ⚠️ IT READS NOTHING THE PROJECT TREE READS. Its lists arrive on their own prop
 * from their own query (see sidebar-panel.tsx), so there is no shared array to
 * partition and no way for this feature to empty the tree above it. That is the
 * whole reason the two are separate queries rather than one clever one.
 *
 * THIS GROUP DOES NOT COUNT ANYTHING, and that is a choice rather than a gap.
 * The project tree carries open-task and pending-request counts because a lead
 * needs to know how much is sitting in a list they are not looking at. Your own
 * to-do list is the one you already opened; a number beside it says nothing you
 * did not know, and it would put a permanent `0` beside every empty list, which
 * is the habit the dashboard's QA tile is written to avoid.
 *
 * Rendered for EVERYBODY, at every rank. There is no `canManageLists` here and
 * there must not be: `savePersonalList` gates on being signed in, and the policy
 * underneath asks only whether the row is yours. A rank test would be a second
 * opinion about a decision the database already makes on identity alone.
 */

export type PersonalList = {
  id: string;
  name: string;
  /**
   * ⚠️ ARCHIVED LISTS ARE PASSED IN, NOT FILTERED OUT UPSTREAM, and that is what
   * makes archiving reversible.
   *
   * The first version of this took only the active ones, which is what every
   * other lists query in the app does — and it made the Active switch in the
   * dialog a ONE-WAY DOOR. Archive a list, it leaves the sidebar, and the only
   * screen that could bring it back is `/tasks/lists`, which shows department
   * lists and refuses a plain member outright. There was no route back at all.
   */
  isActive: boolean;
};

export function NavPersonal({
  lists,
  unavailable = false,
}: {
  lists: PersonalList[];
  /**
   * P12-01 — the snapshot could not be read, so `lists` is empty because we do
   * not KNOW, not because there are none.
   *
   * ⚠️ WITHOUT THIS THE GROUP STATES A FALSEHOOD. An empty `lists` renders "No
   * lists yet", which to somebody holding four personal lists is the app
   * telling them their work is gone — and it is the exact silent-empty this
   * phase exists to kill, six pixels under the Projects group that reports the
   * failure honestly.
   */
  unavailable?: boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  // The same rule as the project tree: `?list=` IS the route, and both shapes of
  // a list — List and Board — count as being inside it. See nav-projects.tsx.
  const onTaskView = pathname === "/tasks" || pathname === "/tasks/board";
  const activeList = onTaskView ? params.get("list") : null;

  // The view survives the jump, exactly as it does in the project tree: somebody
  // working on a board who clicks another list expects the next board.
  const base = pathname === "/tasks/board" ? "/tasks/board" : "/tasks";

  const active = lists.filter((list) => list.isActive);
  const archived = lists.filter((list) => !list.isActive);

  const [editing, setEditing] = useState<PersonalList | null>(null);
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  function create() {
    setEditing(null);
    setOpen(true);
  }

  function edit(list: PersonalList) {
    setEditing(list);
    setOpen(true);
  }

  return (
    <>
      <Collapsible defaultOpen render={<SidebarGroup />}>
        {/* The group class rides the TRIGGER, and the chevron keys off
            `aria-expanded` rather than `data-open` — both for the reasons
            written out at length in app-sidebar.tsx. `group/personal` is named
            so opening this group does not rotate every chevron in the rail. */}
        <SidebarGroupLabel
          render={<CollapsibleTrigger />}
          className="group/personal cursor-pointer hover:text-foreground"
        >
          Personal lists
          <ChevronDown
            aria-hidden
            className="ml-auto size-4 shrink-0 transition-transform group-aria-expanded/personal:rotate-180"
          />
        </SidebarGroupLabel>

        <CollapsibleContent render={<SidebarGroupContent />}>
          <SidebarMenu>
            {/*
              ⚠️ ONE FIXED NODE, AND EVERY LIST HANGS OFF IT.

              This group used to render the lists FLAT — one row per list under
              the heading — and Amier's correction (8 Sep) is that it should be a
              space you put lists inside, the way VizBytes is: "make it fixed
              like this since we can add a tasks lists under of this".

              The flat version was not wrong so much as shallow. The rail's whole
              grammar is Space → (Folder) → List, and a group that broke it read
              as a different kind of thing than the tree six pixels above it. One
              node restores the grammar and gives the `+` somewhere to live that
              is not the group heading.
            */}
            <PersonalSpace
              lists={active}
              archived={archived}
              unavailable={unavailable}
              activeList={activeList}
              base={base}
              onEdit={edit}
              onCreate={create}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((shown) => !shown)}
            />
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>

      <PersonalListDialog
        key={editing?.id ?? "new"}
        list={editing}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * The name of the fixed node.
 *
 * ⚠️ A CONSTANT, NOT A ROW, AND THAT IS WHAT "FIXED" MEANS HERE. The obvious
 * alternative is to give it a real record — a `vizserve_pms_task_groups` folder
 * with an owner — and it buys nothing and costs a lot: the P11-06 check
 * constraint says a personal list sits in NO folder, every person would need one
 * backfilled at signup, and a row that exists can be renamed, archived or
 * deleted, which is precisely what this must not be. A label in the component
 * cannot drift, cannot go missing for a new account, and cannot be edited into
 * something confusing.
 *
 * It is also why there is no migration behind this change at all.
 */
const SPACE_NAME = "Personal Space";

/**
 * The fixed space, holding every personal list.
 *
 * Shaped after `SpaceNode` in nav-projects.tsx on purpose — same `Folder` icon,
 * same right-pointing chevron that rotates on `aria-expanded`, same nesting into
 * a `SidebarMenuSub`. Two things at the same level of the rail that look
 * different are two things people have to learn separately.
 */
function PersonalSpace({
  lists,
  archived,
  activeList,
  base,
  onEdit,
  onCreate,
  showArchived,
  onToggleArchived,
  unavailable,
}: {
  lists: PersonalList[];
  archived: PersonalList[];
  unavailable: boolean;
  activeList: string | null;
  base: string;
  onEdit: (list: PersonalList) => void;
  onCreate: () => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  const holds =
    lists.some((list) => list.id === activeList) ||
    archived.some((list) => list.id === activeList);

  const [open, setOpen] = useHoldsActive(holds);

  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuItem />}>
      <CollapsibleTrigger
        render={
          // `group/space` on the BUTTON, which is what carries `aria-expanded` —
          // the same rule as the group label above, and named so opening this
          // one does not rotate every chevron in the rail.
          <SidebarMenuButton tooltip={SPACE_NAME} className="group/space">
            <Folder />
            <span className="flex-1 truncate">{SPACE_NAME}</span>
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/space:rotate-90"
            />
          </SidebarMenuButton>
        }
      />

      <CollapsibleContent>
        <SidebarMenuSub>
          {lists.map((list) => (
            <PersonalRow
              key={list.id}
              list={list}
              href={`${base}?list=${list.id}`}
              isActive={list.id === activeList}
              onEdit={onEdit}
            />
          ))}

          {/* ⚠️ "NO LISTS YET" IS A CLAIM ABOUT DATA, so it may only be made when
              the data actually arrived. On a failed snapshot the honest row is
              that we could not read it — see `unavailable` above. */}
          {lists.length === 0 ? (
            <SidebarMenuSubItem>
              <span
                role={unavailable ? "status" : undefined}
                className="block px-2 py-1 text-2xs text-muted-foreground"
              >
                {unavailable ? "Couldn’t load your lists. Trying again." : "No lists yet"}
              </span>
            </SidebarMenuSubItem>
          ) : null}

          {/*
            ⚠️ AN ALWAYS-VISIBLE ROW, NOT A HOVER `+` ON THE SPACE ABOVE.

            A folder in the project tree gets its `+` on hover, and that is right
            there: a lead already has folders and lists and knows the control
            exists. Here the common state on day one is ZERO lists, and a
            hover-only control inside a node somebody has not opened yet is a
            feature nobody finds. nav-projects makes the same call for the same
            reason at its own empty state.

            One control, not two: there is deliberately no `+` on the space row
            beside this. Two ways to open one dialog is one more than the dialog
            deserves — the note on the folder `…` in nav-projects.tsx.
          */}
          {/* Hidden while the set is unknown: "New list" beside a failed read
              invites somebody to add a second list called the same thing as one
              they already have and cannot currently see. */}
          {unavailable ? null : (
          <SidebarMenuSubItem>
            {/*
              ⚠️ `render={<button type="button" />}` IS LOAD-BEARING.
              `SidebarMenuSubButton` defaults to `<a>` (sidebar.tsx), unlike
              `SidebarMenuButton` which defaults to `<button>`. Without this it
              renders as an `<a>` with no href: not keyboard focusable, wrong
              role, and silently so — it still opens on a mouse click, which is
              exactly how this would ship unnoticed. Same note as the folder
              trigger in nav-projects.tsx.
            */}
            <SidebarMenuSubButton
              render={<button type="button" />}
              className="w-full text-left text-muted-foreground"
              onClick={onCreate}
            >
              <Plus className="size-3.5 shrink-0" />
              <span>New list</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
          )}

          {/*
            THE WAY BACK from the Active switch, and the reason archived lists
            are fetched at all.

            Shut by default and absent entirely at zero, so the ordinary case —
            nobody has archived anything — costs a row that is never rendered.
            The count is in the label because "Archived" on its own gives no
            reason to open it.
          */}
          {archived.length > 0 ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                aria-expanded={showArchived}
                className="group/archived w-full text-left text-2xs text-muted-foreground"
                onClick={onToggleArchived}
              >
                <ChevronRight
                  aria-hidden
                  className="size-3.5 shrink-0 transition-transform group-aria-expanded/archived:rotate-90"
                />
                <span>Archived ({archived.length})</span>
              </SidebarMenuSubButton>

              {showArchived ? (
                <SidebarMenuSub>
                  {archived.map((list) => (
                    <PersonalRow
                      key={list.id}
                      list={list}
                      href={`${base}?list=${list.id}`}
                      isActive={list.id === activeList}
                      onEdit={onEdit}
                    />
                  ))}
                </SidebarMenuSub>
              ) : null}
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Open when something inside is being looked at.
 *
 * ⚠️ CONTROLLED, NOT `defaultOpen`, AND THAT IS A BUG FIX RATHER THAN A STYLE.
 * `defaultOpen` applies only at mount, and the app shell does not remount across
 * client navigations — so arriving at a personal list from anywhere other than
 * this node would leave the node holding it shut, with no indication the list
 * you are staring at is inside.
 *
 * Forced open on arrival, never forced shut: an explicit collapse by the reader
 * sticks until they navigate back into it. Adjusted DURING RENDER rather than in
 * an effect — React's own lint refuses the effect version, and it renders the
 * closed state once before correcting it, which is a visible flicker on every
 * navigation. Lifted verbatim from nav-projects.tsx, where the full argument is.
 */
function useHoldsActive(holds: boolean) {
  const [open, setOpen] = useState(holds);
  const [wasHolding, setWasHolding] = useState(holds);

  if (holds !== wasHolding) {
    setWasHolding(holds);
    if (holds) setOpen(true);
  }

  return [open, setOpen] as const;
}

/**
 * One list, active or archived.
 *
 * An archived list is still a LINK, not a disabled row. The tasks in it are real
 * and their hours are on somebody's timesheet — archiving hid the list, it did
 * not retire the work, and a row you cannot open would make the archive a place
 * things go to become unreadable.
 *
 * The state is carried in words, never by the dim tone alone (the standing rule
 * — every status pill in this app carries its label). Here the word is in the
 * `sr-only` half of the action's name and in the visible "Archived (n)" heading
 * the row sits under, so it is legible both ways round.
 */
function PersonalRow({
  list,
  href,
  isActive,
  onEdit,
}: {
  list: PersonalList;
  href: string;
  isActive: boolean;
  onEdit: (list: PersonalList) => void;
}) {
  return (
    <SidebarMenuSubItem>
      {/*
        `prefetch` for the same reason the project tree uses it: a visible <Link>
        already prefetches the SHELL of /tasks, but one shell is shared by every
        link to that route and so cannot include anything that depends on
        `?list=`. Bounded by how many lists one person made, and it is navigation
        used dozens of times an hour. Not on an archived row — that one is a
        recovery route, not a daily one.
      */}
      <SidebarMenuSubButton
        isActive={isActive}
        className={list.isActive ? "pr-9" : "pr-9 opacity-60"}
        render={<Link href={href} prefetch={list.isActive} />}
      >
        <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{list.name}</span>
        <LinkPending />
      </SidebarMenuSubButton>

      {/*
        `showOnHover` is NOT passed and must not be: it keys on
        `group-hover/menu-item`, and `group/menu-item` only exists on
        `SidebarMenuItem`. This row is a `SidebarMenuSubItem`, which carries
        `group/menu-sub-item` — so the prop would be silently dead and the hover
        classes are supplied by hand. `top-0.5 size-5` because the built-in
        `top-1.5` is sized for an h-10 button and this row is h-7. Same note as
        the folder `+` in nav-projects.tsx.
      */}
      <SidebarMenuAction
        type="button"
        className="top-0.5 size-5 opacity-0 group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100"
        onClick={() => onEdit(list)}
      >
        <MoreHorizontal />
        <span className="sr-only">
          {list.isActive
            ? `Rename or archive ${list.name}`
            : `Rename or restore ${list.name}, archived`}
        </span>
      </SidebarMenuAction>
    </SidebarMenuSubItem>
  );
}

/**
 * Create, rename or archive — one dialog, because they are one form.
 *
 * ⚠️ `key` ON THE CALL SITE IS LOAD-BEARING. Closing a dialog does not unmount
 * it, so without the key the name field would still hold whatever the last list
 * opened put there — the trap `new-personal-task-dialog.tsx` records at length.
 * Keying on the list id remounts the form whenever the subject changes, which is
 * cheaper and harder to get wrong than resetting field by field.
 *
 * There is no Delete. Archiving is what "take it out of my sidebar" means here,
 * and the tasks inside keep their hours — see `savePersonalList`.
 */
function PersonalListDialog({
  list,
  open,
  onOpenChange,
}: {
  list: PersonalList | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(list?.name ?? "");
  // A new list starts active; an existing one starts wherever it already is, so
  // opening this on an archived list offers Restore rather than silently
  // re-activating it on save.
  const [isActive, setIsActive] = useState(list?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  function submit() {
    setErrors({});

    startTransition(async () => {
      const result = await savePersonalList(list?.id ?? null, { name, is_active: isActive });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      onOpenChange(false);
      toast.success(list ? "List saved." : "List created.");

      /*
       * `router.refresh()` as well as the action's `revalidatePath`, and both
       * are needed. The action marks `/tasks` and friends stale; THIS GROUP
       * lives in the app layout, which those paths do not cover — so without the
       * refresh the list you just made would not appear until the next full
       * navigation.
       */
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{list ? "Edit list" : "New personal list"}</DialogTitle>
          {/*
            ⚠️ THIS SENTENCE IS THE ONLY PLACE THE RULE IS STATED TO THE PERSON IT
            APPLIES TO, so it says the whole rule rather than the comfortable
            half. "Only you can see this" on its own would be a promise the
            product does not keep: log an hour against one of these tasks and
            your lead reads the title on their team timesheet.

            P11-08 changed WHEN — it said "when you submit that week's timesheet"
            and the trigger is now logging the time, not submitting. Naming the
            act keeps it predictable: the visibility changes at a moment somebody
            chooses, and a task nobody has logged against stays entirely private.
          */}
          <DialogDescription>
            Only you can see this list, and only your own tasks can go in it. Log time against
            one and your team leader sees it on their team timesheet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="personal_list_name">Name</Label>
            <Input
              id="personal_list_name"
              value={name}
              autoFocus
              maxLength={80}
              placeholder="Errands"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // Enter saves. This form is one field, and reaching for the
                // mouse to commit one word is the kind of friction that stops
                // people using a to-do list at all.
                if (event.key === "Enter" && !pending && name.trim().length > 0) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <FieldError messages={errors.name} />
          </div>

          {/* Offered only when editing. On a new list it would be a switch whose
              only useful position is the one it starts in. */}
          {list ? (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">
                  Archiving hides the list from your sidebar. The tasks in it keep their hours.
                </p>
              </div>
              <Switch id="personal_list_active" checked={isActive} onCheckedChange={setIsActive} />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || name.trim().length === 0}>
            {pending ? "Saving…" : list ? "Save" : "Create list"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

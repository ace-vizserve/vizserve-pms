"use client";

import { toast } from "@/components/ui/toast";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { QueryError } from "@/components/query-error";
import { TableSkeleton } from "@/components/skeletons";
import { Chip } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { browserClient } from "@/lib/query/browser-client";
import { fetchManagedLists, type ManagedLists } from "@/lib/query/fetchers/lists";
import { qk } from "@/lib/query/keys";
import { fromAction } from "@/lib/query/mutate";
import { beginWrite, cancelRefetches, rollbackWrite } from "@/lib/query/write-cache";
import type { ManagedGroup, ManagedList } from "@/lib/schemas/lists";

import { saveList, saveTaskGroup } from "../actions";

/**
 * P3-01 / P12-16 — managing lists, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT THIS FILE STOPPED BEING.
 *
 * This was the largest client component in the repo and most of it was a
 * hand-rolled cache: the whole tree arrived as four props from an RSC, a
 * `useOptimistic` reducer patched a local copy of the list array so a rename
 * would show before the round trip, and every save ended in `router.refresh()`
 * held open inside a `startTransition` — because `useOptimistic` DROPS ITS VALUE
 * the instant the transition that set it ends, so the transition had to outlive
 * a full server re-render of four queries.
 *
 * All three of those are gone and one mechanism replaced them. `qk.listsManaged()`
 * holds the tree, `onMutate` patches the entry (which keeps its value until
 * something replaces it — nothing reverts, because nothing about it is scoped to
 * a transition), and `onSettled` invalidates. The rename is instant and the
 * refetch lands underneath a screen that already shows the right thing.
 *
 * ⚠️ AND `onError` IS NOW REAL CODE. React used to put the old name back for
 * free. `rollbackWrite` restores the snapshot; without it a refused save would
 * leave the new name on screen with a toast that scrolls away, which is exactly
 * the failure `tasks/inline.tsx` forbids in capitals.
 *
 * ⚠️ THE DEPARTMENTS DID NOT MOVE AND MUST NOT. `departmentTreeScope()` lives in
 * a `server-only` module, so which departments this person may file a folder or
 * list under is resolved in `page.tsx` and arrives as a prop. No decision about
 * what anybody may see or do is made in this file; `saveList` and `saveTaskGroup`
 * re-check the department, and the lists and folders policies re-check it again.
 * ------------------------------------------------------------------------
 */

/*
 * ⚠️ THE THREE ROW TYPES ARE THE CONTRACT'S NOW, NOT LOCAL DECLARATIONS.
 *
 * `ListRow` and `GroupRow` were written out by hand at the top of this file and
 * had to match, field for field, a `.select()` string in a different file that
 * nothing checked them against. They are `ManagedList` and `ManagedGroup` in
 * `lib/schemas/lists.ts` now — parsed on arrival, so a dropped column is a
 * sentence rather than an `undefined` that quietly reorganises a department.
 * The aliases are kept because this file names them forty times.
 */
type ListRow = ManagedList;
type GroupRow = ManagedGroup;

type Department = { id: string; name: string };

/**
 * The sentinel for "no folder".
 *
 * A Select cannot carry `null` as a value, and an empty string reads as
 * "nothing chosen yet" rather than as a choice.
 */
const NO_FOLDER = "__none__";

/** The Server Actions, as promises TanStack can drive `onError` off. */
const writeList = fromAction(saveList);
const writeGroup = fromAction(saveTaskGroup);

/**
 * ⚠️ ONE ROOT, AND IT IS THE PREFIX RATHER THAN THIS SCREEN'S KEY.
 *
 * `["lists"]` covers `qk.listsManaged()`, `qk.listsVisible()` and
 * `qk.lists(departmentId)`. Snapshotting and rolling back the whole prefix is
 * what makes a refused save put back everything a successful one would have
 * moved — and `listsVisible` is genuinely in that set: archiving a list here
 * removes it from the `/tasks` filter dropdown, and a rollback that restored
 * only this screen's entry would leave the two disagreeing until the next
 * refetch.
 */
const LIST_ROOTS = [["lists"]] as const;

/*
 * ⚠️ MODULE-SCOPED, AND THE IDENTITY IS THE POINT. `treeQuery.data?.lists ?? []`
 * builds a NEW array on every render while the query is still pending, which
 * makes the `useMemo`s below re-bucket the whole tree every time — the exact
 * thing eslint's exhaustive-deps rule reports and the exact reason a stable
 * reference matters more here than the allocation does.
 */
const NO_LISTS: ManagedList[] = [];
const NO_GROUPS: ManagedGroup[] = [];
const NO_COUNTS: Record<string, number> = {};

/**
 * Apply an edit to one row inside the cached tree.
 *
 * ⚠️ THE PATCH IS PARTIAL ON PURPOSE, exactly as the `useOptimistic` reducer it
 * replaces was. A save can change a name, a description, whether it is archived
 * and which folder it sits in, and spreading only what was sent leaves
 * everything else exactly as the server last said it was.
 *
 * ⚠️ AN UNCHANGED ENTRY IS RETURNED BY REFERENCE. `setQueryData` notifies its
 * observers whenever the value is not identical, so rebuilding an entry that did
 * not contain the row would re-render the whole tree for nothing.
 */
function patchRow<K extends "lists" | "groups">(
  client: QueryClient,
  which: K,
  id: string,
  fields: Partial<ManagedLists[K][number]>,
): void {
  client.setQueryData<ManagedLists>(qk.listsManaged(), (current) => {
    if (!current) return current;
    let touched = false;
    const rows = current[which].map((row) => {
      if (row.id !== id) return row;
      touched = true;
      return { ...row, ...fields };
    });
    return touched ? { ...current, [which]: rows } : current;
  });
}

export function ListManager({ departments }: { departments: Department[] }) {
  /*
   * ⚠️ ONE QUERY WHERE FOUR PROPS USED TO ARRIVE, and the folders, the lists and
   * the open counts share the entry deliberately — `qk.listsManaged()` in
   * `keys.ts` argues why at length. The short version: a rename, an archive and
   * a move each touch more than one of the three.
   *
   * ⚠️ `browserClient()` IS CALLED INSIDE THE `queryFn`, NEVER IN THIS BODY. A
   * `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie` — which is why
   * that helper is lazy, and why calling it up here would move that reach into
   * the server pass. A `queryFn` only ever runs in the browser.
   */
  const treeQuery = useQuery({
    queryKey: qk.listsManaged(),
    queryFn: () => fetchManagedLists(browserClient()),
  });

  const [editingList, setEditingList] = useState<ListRow | null>(null);
  const [listOpen, setListOpen] = useState(false);
  /** P7-25. The folder a new list should start in, when opened from its heading. */
  const [seedFolder, setSeedFolder] = useState<GroupRow | null>(null);
  const [editingGroup, setEditingGroup] = useState<GroupRow | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);

  /*
   * ⚠️ THE THREE ARE READ OFF THE ENTRY, AND THE `?? []`S HERE ARE NOT THE
   * `?? []`S P12-01 REMOVED.
   *
   * A failed read is caught below and renders `QueryError` before any of this is
   * drawn — that is the whole rule (`lib/query/read.ts`). These defaults cover
   * the FIRST RENDER, where `data` is `undefined` because nothing has come back
   * yet, and the skeleton branch below is what is actually on screen for it. An
   * empty tree can never reach the empty state by way of a failure.
   */
  const lists = treeQuery.data?.lists ?? NO_LISTS;
  const groups = treeQuery.data?.groups ?? NO_GROUPS;
  const openCounts = treeQuery.data?.openCounts ?? NO_COUNTS;

  /**
   * Lists bucketed by `${department}:${folder}`, folderless under `:none`.
   *
   * One map rather than two passes: the render below asks for a department's
   * folderless lists and then each folder's lists, and both are the same lookup.
   */
  const listsByGroup = useMemo(() => {
    const buckets = new Map<string, ListRow[]>();
    for (const list of lists) {
      const key = `${list.department_id}:${list.group_id ?? "none"}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(list);
      buckets.set(key, bucket);
    }
    return buckets;
  }, [lists]);

  /**
   * Folders per department, ORDERED WITH THE SYSTEM ONE LAST.
   *
   * The tiebreak is on `is_system` rather than on `sort_order` alone. The
   * migration gives Client Requests `sort_order 1000`, but a rule that depends
   * on a number a lead can out-bid is a rule that breaks the first time somebody
   * numbers a folder 2000 and wonders why client work moved.
   */
  const groupsByDepartment = useMemo(() => {
    const buckets = new Map<string, GroupRow[]>();
    for (const group of groups) {
      const bucket = buckets.get(group.department_id) ?? [];
      bucket.push(group);
      buckets.set(group.department_id, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.sort(
        (a, b) =>
          Number(a.is_system) - Number(b.is_system) || a.sort_order - b.sort_order || a.name.localeCompare(b.name),
      );
    }
    return buckets;
  }, [groups]);

  function createList() {
    setEditingList(null);
    setSeedFolder(null);
    setListOpen(true);
  }

  /**
   * "Add a list" from a FOLDER heading, rather than from the page's own button.
   *
   * Without this the only route was the top-level New list button followed by
   * picking the department and the folder again from scratch — on a screen that
   * is already showing you the folder you meant. Since P7-25 the reserved
   * Client Requests folder is a legitimate destination too, which made the
   * missing control more obvious: there was no way to say "put it in here".
   *
   * Seeds the form rather than writing anything. Everything is still editable
   * before Save, and `saveList` re-checks the department either way.
   */
  function addListTo(folder: GroupRow) {
    setEditingList(null);
    setSeedFolder(folder);
    setListOpen(true);
  }

  function createGroup() {
    setEditingGroup(null);
    setGroupOpen(true);
  }

  function editList(list: ListRow) {
    setEditingList(list);
    setListOpen(true);
  }

  if (departments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm font-medium">You do not lead a department</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Folders and lists belong to the department that uses them. An admin can add you to one.
        </p>
      </div>
    );
  }

  /*
   * ⚠️ THE FAILED READ IS SAID OUT LOUD, AND ON THIS SCREEN IT HAS TO BE. The
   * empty state below reads "Nothing organised yet" and offers a button to
   * create the first list — so a broken query would not merely mislead, it would
   * invite somebody to make a duplicate of a list they already have. This branch
   * is the whole reason `fetchManagedLists` throws instead of returning `[]`.
   *
   * BEFORE the pending branch: an entry that has data and is refetching in the
   * background must keep drawing its rows, but an entry that FAILED has nothing
   * to draw and must not sit on a skeleton forever.
   */
  if (treeQuery.isError) {
    return <QueryError what="your department's lists" message={treeQuery.error.message} />;
  }

  /*
   * ⚠️ `isPending` IS "NO DATA YET", NOT "FETCHING". A background refetch over
   * data we already have must NOT throw the tree away and redraw a skeleton,
   * which is the flicker the whole cache exists to remove — and on this screen
   * it would happen after every single save.
   */
  if (treeQuery.isPending) {
    return <TableSkeleton columns={3} rows={6} />;
  }

  const nothingYet = lists.length === 0 && groups.every((group) => group.is_system);

  return (
    <>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={createGroup}>
          <FolderPlus />
          New folder
        </Button>
        <Button size="sm" onClick={createList}>
          <Plus />
          New list
        </Button>
      </div>

      {nothingYet ? (
        <div className="rounded-lg border border-dashed p-10 text-center bg-card grade-raised">
          <p className="text-sm font-medium">Nothing organised yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Tasks work fine without any of this. Add a list when a department has enough going on that &ldquo;which
            project is this?&rdquo; becomes a real question, and a folder when it has enough lists that the same is true
            of them.
          </p>
          <Button size="sm" className="mt-4" onClick={createList}>
            Create the first list
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {departments.map((department) => {
            const loose = listsByGroup.get(`${department.id}:none`) ?? [];
            const folders = groupsByDepartment.get(department.id) ?? [];

            // A department with no folders and no loose lists has nothing to
            // show.
            //
            // ⚠️ The Client Requests folder USED TO NOT COUNT here — "every
            // department has one, and an empty one is not news". Since P7-25 it
            // is somewhere a lead can deliberately file client work, so an empty
            // one IS news: it is the destination they are looking for.
            const worthShowing = loose.length > 0 || folders.length > 0;

            if (!worthShowing) return null;

            return (
              <section className="bg-card grade-surface rounded-lg p-4" key={department.id}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {department.name}
                </h2>

                {/* Folderless lists first. After P7-18 every list that already
                    existed is one of these, so putting folders above would bury
                    the whole company's work under an empty heading. */}
                {loose.length > 0 ? <ListRows lists={loose} openCounts={openCounts} onEdit={editList} /> : null}

                {folders.map((folder) => {
                  const folderLists = listsByGroup.get(`${department.id}:${folder.id}`) ?? [];

                  // ⚠️ The reserved folder USED TO BE HIDDEN while empty, on
                  // the grounds that a permanently empty CLIENT REQUESTS on
                  // every team's screen teaches people to stop reading the
                  // headings. That held while nothing could be put in it by
                  // hand. Since P7-25 it is a place a lead deliberately files
                  // client work, and a destination you cannot see is a
                  // destination nobody uses — so it now renders with an empty
                  // state like any other folder.

                  return (
                    <div key={folder.id} className="mt-4">
                      <div className="mb-2 flex items-center gap-2">
                        <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {folder.name}
                        </h3>

                        {!folder.is_active ? <Chip tone="neutral" label="Archived" /> : null}

                        {/* P7-25 — add a list straight into THIS folder.
                            Every folder takes lists, the reserved one included
                            since the guard was relaxed, so this control is
                            unconditional. It is the pencil's neighbour rather
                            than a row at the bottom of the folder: the heading
                            is what you are pointing at when you decide. */}
                        <Button variant="ghost" size="sm" className="size-6 p-0" onClick={() => addListTo(folder)}>
                          <Plus className="size-3.5" />
                          <span className="sr-only">Add a list to {folder.name}</span>
                        </Button>

                        {/* No pencil on the reserved folder. It cannot be
                            renamed, archived or deleted, so the control could
                            only ever produce an error message. */}
                        {!folder.is_system ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-6 p-0"
                            onClick={() => {
                              setEditingGroup(folder);
                              setGroupOpen(true);
                            }}>
                            <Pencil className="size-3" />
                            <span className="sr-only">Edit folder {folder.name}</span>
                          </Button>
                        ) : null}
                      </div>

                      {folderLists.length > 0 ? (
                        <ListRows lists={folderLists} openCounts={openCounts} onEdit={editList} />
                      ) : (
                        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                          Empty. Put a list in it from the New list button.
                        </p>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={listOpen} onOpenChange={setListOpen}>
        <DialogContent className="sm:max-w-md">
          {/* Keyed and unmounted while closed, so the fields are seeded rather
              than synced — editing one list then another must not carry the
              first one's name across. */}
          {listOpen ? (
            <ListForm
              key={editingList?.id ?? `new:${seedFolder?.id ?? "none"}`}
              list={editingList}
              seedFolder={seedFolder}
              departments={departments}
              groups={groups}
              openCount={editingList ? (openCounts[editingList.id] ?? 0) : 0}
              onDone={() => setListOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent className="sm:max-w-md">
          {groupOpen ? (
            <GroupForm
              key={editingGroup?.id ?? "new"}
              group={editingGroup}
              departments={departments}
              listCount={
                editingGroup ? (listsByGroup.get(`${editingGroup.department_id}:${editingGroup.id}`) ?? []).length : 0
              }
              onDone={() => setGroupOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One bordered block of list rows. Extracted because it renders three times. */
function ListRows({
  lists,
  openCounts,
  onEdit,
}: {
  lists: ListRow[];
  openCounts: Record<string, number>;
  onEdit: (list: ListRow) => void;
}) {
  return (
    <ul className="overflow-hidden rounded-lg border bg-card grade-raised">
      {lists.map((list) => (
        <li key={list.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b p-3 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{list.name}</span>
              {/* Never colour alone — the word carries the state. */}
              {!list.is_active ? <Chip tone="neutral" label="Archived" /> : null}
              {/* Provenance, not state — where this list came from does not
                  change, so it is a `Badge` and carries no status dot. */}
              {list.form_id ? <Badge variant="secondary">From a form</Badge> : null}
            </div>
            {list.description ? <p className="mt-0.5 text-xs text-muted-foreground">{list.description}</p> : null}
          </div>

          <span className="shrink-0 text-2xs text-muted-foreground">{openCounts[list.id] ?? 0} open</span>

          <Button variant="ghost" size="sm" onClick={() => onEdit(list)}>
            <Pencil />
            <span className="sr-only">Edit {list.name}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ListForm({
  list,
  seedFolder,
  departments,
  groups,
  openCount,
  onDone,
}: {
  list: ListRow | null;
  /**
   * P7-25. The folder this form was opened FROM, when it was opened from a
   * folder heading rather than the page's New list button.
   *
   * Only ever read on a NEW list — editing an existing one takes its folder
   * from the row, and letting a seed override that would silently move a list
   * somebody opened to rename.
   */
  seedFolder: GroupRow | null;
  departments: Department[];
  groups: GroupRow[];
  openCount: number;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  // The seeded folder decides the department too — a folder belongs to one, and
  // landing on a department the folder is not in would make the folder vanish
  // from the picker the moment the dialog opened.
  const [departmentId, setDepartmentId] = useState(
    list?.department_id ?? seedFolder?.department_id ?? departments[0]!.id,
  );
  const [groupId, setGroupId] = useState(list?.group_id ?? seedFolder?.id ?? NO_FOLDER);
  const [isActive, setIsActive] = useState(list?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(list?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  /** A form's inbox list is locked to the reserved folder and to being available. */
  const isFormList = Boolean(list?.form_id);

  /*
   * This department's own folders, INCLUDING the reserved one.
   *
   * ⚠️ `!group.is_system` USED TO BE IN THIS FILTER and its removal is the
   * point of P7-25. The old comment read "Offering Client Requests would be
   * worse, because the refusal arrives only after the whole form is filled in"
   * — true while `vizserve_pms_lists_group_guard` refused a hand-made list
   * there. It no longer does.
   *
   * A lead approving a client request wants a list for that work, and Client
   * Requests is the folder client work belongs in. Excluding it meant client
   * work had to be filed under a folder named after something else.
   *
   * The department filter STAYS. Offering another department's folder is still
   * a guaranteed rejection — the guard answers "That folder belongs to another
   * department."
   */
  const folders = groups.filter((group) => group.department_id === departmentId && group.is_active);

  /*
   * value → label maps for BOTH Selects below.
   *
   * ⚠️ Base UI's SelectValue renders the RAW VALUE unless the Select root is
   * given `items`. Without it the Department trigger showed a bare
   * `a1000000-0000-4000-8000-…` instead of "VizBytes", and the Folder trigger
   * would show the literal "__none__". `form-settings.tsx:83` and
   * `filters.tsx:78` both carry the same pair of maps for the same reason.
   *
   * The `<SelectItem>` children below are NOT a substitute: they populate the
   * popup, the map populates the trigger, and labelling only one is how the two
   * drift apart.
   */
  const departmentItems = Object.fromEntries(departments.map((department) => [department.id, department.name]));

  const folderItems = {
    [NO_FOLDER]: "No folder — top level",
    ...Object.fromEntries(folders.map((folder) => [folder.id, folder.name])),
  };

  /*
   * ------------------------------------------------------------------------
   * P12-16 — THE ROW MOVES WHEN YOU SAVE, AND THE DIALOG CLOSES WHEN THE WRITE
   * RETURNS. Those used to be one moment about a second apart, in that order.
   *
   * The paint was already instant (P11-05, a `useOptimistic` in the PARENT —
   * the row this changes is behind the dialog, so state in here would have
   * repainted nothing anybody could see). But `useOptimistic` DROPS ITS VALUE
   * WHEN ITS TRANSITION ENDS, so the transition had to be held open across a
   * `router.refresh()`: a full server re-render of four queries, including the
   * scan of every open task in scope, before the dialog would close.
   *
   * ⚠️ THE HOLD IS NOT REMOVED, IT IS RELOCATED. `onMutate` writes the new
   * fields into the CACHED TREE — the same entry the rows behind this dialog
   * render from — so the value survives on its own and there is nothing left to
   * hold. It does not revert, because nothing about it is scoped to a
   * transition.
   *
   * ⚠️ ONLY AN EDIT CAN BE PREDICTED. A new list has no id yet, and inventing
   * one would put a row on screen that no control could open. A creation paints
   * nothing and waits for `onSettled` — which is honest: until the server
   * answers, there is no list.
   * ------------------------------------------------------------------------
   */
  const save = useMutation({
    mutationFn: () =>
      writeList(list?.id ?? null, {
        department_id: departmentId,
        name,
        description,
        is_active: isActive,
        sort_order: sortOrder,
        group_id: groupId === NO_FOLDER ? null : groupId,
      }),

    onMutate: () => {
      const snapshot = beginWrite(queryClient, LIST_ROOTS);

      if (list) {
        patchRow(queryClient, "lists", list.id, {
          name,
          description,
          is_active: isActive,
          // The field holds a string; the row holds a number. The action coerces
          // it too — this is the same coercion, one layer up.
          sort_order: Number(sortOrder) || 0,
          group_id: groupId === NO_FOLDER ? null : groupId,
        });
      }

      // Fired, not awaited, and AFTER the patch — see `cancelRefetches`.
      cancelRefetches(queryClient, LIST_ROOTS);

      return snapshot;
    },

    /* ⚠️ THE SNAPSHOT GOES BACK. A refused save that leaves the new name on the
       row behind the dialog is the browser lying about the database, and the
       toast saying so scrolls away. `useOptimistic` did this for free; this
       does not. */
    onError: (mutationError, _vars, snapshot) => {
      if (snapshot) rollbackWrite(queryClient, snapshot);
      setError(mutationError.message);
    },

    onSuccess: () => {
      // Reports the WRITE, which has already happened. Nothing is awaited before
      // it, so it is not reporting a refetch.
      toast.success(list ? "List saved" : "List created");
      onDone();
    },

    /*
     * ⚠️ FIRED, NEVER AWAITED, ON BOTH PATHS — TanStack's documented shape, so
     * the optimistic guess is always reconciled against the server.
     *
     * `["lists"]` is the prefix over this screen's entry AND `qk.listsVisible()`,
     * which is what `/tasks`, `/tasks/board` and `/tasks/[id]` read their list
     * names and their filter dropdown from — archiving a list here has to
     * remove it from there. `qk.snapshot()` is the rail, which draws the same
     * tree with counts: a new list is a new line in the sidebar.
     */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["lists"] });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
    },
  });

  const pending = save.isPending;

  function submit() {
    setError(null);
    save.mutate();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{list ? "Edit list" : "New list"}</DialogTitle>
        <DialogDescription>Lists group a department&apos;s work. Tasks can sit in one, or in none.</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="department">Department</Label>
            <Select
              items={departmentItems}
              value={departmentId}
              onValueChange={(v) => {
                if (v === null) return;
                setDepartmentId(v);
                // ⚠️ RESET THE FOLDER. Department is only editable while
                // creating, which is exactly the window in which a folder picked
                // for the previous department is still selected — and the
                // database refuses that only after the form has been filled in.
                setGroupId(NO_FOLDER);
              }}
              // Moving a list between departments would strand every task in it
              // under a team that cannot see them.
              disabled={Boolean(list)}>
              <SelectTrigger id="department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {list ? (
              <p className="text-xs text-muted-foreground">Fixed — tasks in this list belong to this department.</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sort_order">Order</Label>
            <Input
              id="sort_order"
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Lower shows first.</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="group">Folder</Label>
          <Select
            items={folderItems}
            value={groupId}
            onValueChange={(v) => v !== null && setGroupId(v)}
            disabled={isFormList || folders.length === 0}>
            <SelectTrigger id="group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FOLDER}>No folder — top level</SelectItem>
              {folders.map((folder) => (
                <SelectItem key={folder.id} value={folder.id}>
                  {folder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {isFormList
              ? "Fixed — this list is a form's inbox and lives in Client Requests."
              : folders.length === 0
                ? "This department has no folders yet. A list is fine without one."
                : "A list can sit in a folder or on its own. Client Requests is where client work goes."}
          </p>
        </div>

        {list ? (
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <Label htmlFor="is_active">Available</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isFormList
                  ? "This list is a form's inbox. Archive the form instead."
                  : isActive
                    ? "Offered when assigning work."
                    : "Hidden from the pickers. Tasks already in it stay put."}
              </p>
              {!isActive && openCount > 0 ? (
                <p className="mt-1 text-xs text-warning">
                  {openCount} open {openCount === 1 ? "task is" : "tasks are"} still in this list.
                </p>
              ) : null}
            </div>
            <Switch
              id="is_active"
              checked={isActive}
              onCheckedChange={setIsActive}
              // The server refuses this too — it has to, because the front end
              // will be bypassed. Disabling it here is so nobody fills the form
              // in to be told no.
              disabled={isFormList}
            />
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <form id="save-list" action={submit} className="hidden" />
        <Button type="submit" form="save-list" loading={pending} disabled={name.trim().length === 0}>
          {list ? "Save" : "Create list"}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * P7-18 — the folder form.
 *
 * Deliberately the same shape as `ListForm` minus the folder picker: folders do
 * not nest, so there is nothing to put one inside.
 */
function GroupForm({
  group,
  departments,
  listCount,
  onDone,
}: {
  group: GroupRow | null;
  departments: Department[];
  listCount: number;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [departmentId, setDepartmentId] = useState(group?.department_id ?? departments[0]!.id);
  const [isActive, setIsActive] = useState(group?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(group?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  // Without this the trigger shows a bare UUID — see the note in ListForm.
  const departmentItems = Object.fromEntries(departments.map((department) => [department.id, department.name]));

  /*
   * The same shape as `ListForm`'s `save` above, one level up, and for the same
   * reasons — read the block there rather than a second copy of it here.
   *
   * ⚠️ ONE DIFFERENCE THAT IS NOT COSMETIC: a folder rename moves the LISTS
   * INSIDE IT as well as the heading, because a list row quotes its folder's
   * name in the sidebar. That is why the invalidation is the `["lists"]` prefix
   * rather than this entry, and why `qk.ref("task-groups")` is in it too — the
   * `/tasks` filter panel reads the folder list from there under a ten-minute
   * `REF_STALE_TIME`, so without that key a renamed folder would keep its old
   * name in that dropdown for the rest of the session. `realtime.ts` records
   * exactly the same three keys for a `vizserve_pms_task_groups` event, and
   * keeping the two lists in step is the point of naming them from one place.
   */
  const save = useMutation({
    mutationFn: () =>
      writeGroup(group?.id ?? null, {
        department_id: departmentId,
        name,
        description,
        is_active: isActive,
        sort_order: sortOrder,
      }),

    onMutate: () => {
      const snapshot = beginWrite(queryClient, LIST_ROOTS);

      /* Only an edit can be predicted — a new folder has no id. See `ListForm`. */
      if (group) {
        patchRow(queryClient, "groups", group.id, {
          name,
          description,
          is_active: isActive,
          sort_order: Number(sortOrder) || 0,
        });
      }

      cancelRefetches(queryClient, LIST_ROOTS);

      return snapshot;
    },

    onError: (mutationError, _vars, snapshot) => {
      if (snapshot) rollbackWrite(queryClient, snapshot);
      setError(mutationError.message);
    },

    onSuccess: () => {
      toast.success(group ? "Folder saved" : "Folder created");
      onDone();
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["lists"] });
      void queryClient.invalidateQueries({ queryKey: qk.ref("task-groups") });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
    },
  });

  const pending = save.isPending;

  function submit() {
    setError(null);
    save.mutate();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{group ? "Edit folder" : "New folder"}</DialogTitle>
        <DialogDescription>
          A folder holds lists — one per project or area. Folders do not go inside other folders.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="group_name">Name</Label>
          <Input
            id="group_name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="VizServe Projects"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="group_description">Description</Label>
          <Textarea
            id="group_description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="group_department">Department</Label>
            <Select
              items={departmentItems}
              value={departmentId}
              onValueChange={(v) => v !== null && setDepartmentId(v)}
              // Same rule as a list, one level up: moving a folder would take
              // every list in it to a team that cannot see them. The database
              // refuses it too.
              disabled={Boolean(group)}>
              <SelectTrigger id="group_department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {group ? (
              <p className="text-xs text-muted-foreground">
                Fixed — the lists in this folder belong to this department.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="group_sort_order">Order</Label>
            <Input
              id="group_sort_order"
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Lower shows first.</p>
          </div>
        </div>

        {group ? (
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <Label htmlFor="group_is_active">Available</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isActive
                  ? "Shown in the sidebar and offered when filing a list."
                  : "Hidden. The lists inside it stay where they are."}
              </p>
              {!isActive && listCount > 0 ? (
                <p className="mt-1 text-xs text-warning">
                  {listCount} {listCount === 1 ? "list is" : "lists are"} still in this folder.
                </p>
              ) : null}
            </div>
            <Switch id="group_is_active" checked={isActive} onCheckedChange={setIsActive} />
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <form id="save-folder" action={submit} className="hidden" />
        <Button type="submit" form="save-folder" loading={pending} disabled={name.trim().length === 0}>
          {group ? "Save" : "Create folder"}
        </Button>
      </DialogFooter>
    </>
  );
}

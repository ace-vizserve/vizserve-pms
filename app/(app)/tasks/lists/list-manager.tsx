"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { saveList, saveTaskGroup } from "../actions";

type ListRow = {
  id: string;
  name: string;
  description: string;
  department_id: string;
  is_active: boolean;
  sort_order: number;
  /** P7-18. Null is the top level — a folderless list. */
  group_id: string | null;
  /** P7-18. Set only on a form's auto-created inbox list. */
  form_id: string | null;
};

type GroupRow = {
  id: string;
  name: string;
  description: string;
  department_id: string;
  is_active: boolean;
  sort_order: number;
  is_system: boolean;
};

type Department = { id: string; name: string };

/**
 * The sentinel for "no folder".
 *
 * A Select cannot carry `null` as a value, and an empty string reads as
 * "nothing chosen yet" rather than as a choice.
 */
const NO_FOLDER = "__none__";

export function ListManager({
  lists,
  groups,
  departments,
  openCounts,
}: {
  lists: ListRow[];
  groups: GroupRow[];
  departments: Department[];
  openCounts: Record<string, number>;
}) {
  const [editingList, setEditingList] = useState<ListRow | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupRow | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);

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
          Number(a.is_system) - Number(b.is_system) ||
          a.sort_order - b.sort_order ||
          a.name.localeCompare(b.name),
      );
    }
    return buckets;
  }, [groups]);

  function createList() {
    setEditingList(null);
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
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">Nothing organised yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Tasks work fine without any of this. Add a list when a department has enough going on
            that &ldquo;which project is this?&rdquo; becomes a real question, and a folder when it
            has enough lists that the same is true of them.
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
            // show. Its Client Requests folder alone does not count — every
            // department has one, and an empty one is not news.
            const worthShowing =
              loose.length > 0 ||
              folders.some(
                (folder) =>
                  !folder.is_system ||
                  (listsByGroup.get(`${department.id}:${folder.id}`) ?? []).length > 0,
              );

            if (!worthShowing) return null;

            return (
              <section key={department.id}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {department.name}
                </h2>

                {/* Folderless lists first. After P7-18 every list that already
                    existed is one of these, so putting folders above would bury
                    the whole company's work under an empty heading. */}
                {loose.length > 0 ? (
                  <ListRows lists={loose} openCounts={openCounts} onEdit={editList} />
                ) : null}

                {folders.map((folder) => {
                  const folderLists = listsByGroup.get(`${department.id}:${folder.id}`) ?? [];

                  // The reserved folder is hidden until it holds something.
                  // Every department has one from the migration's backfill, and
                  // a permanently empty CLIENT REQUESTS on every team's screen
                  // teaches people to stop reading the headings.
                  if (folder.is_system && folderLists.length === 0) return null;

                  return (
                    <div key={folder.id} className="mt-4">
                      <div className="mb-2 flex items-center gap-2">
                        <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {folder.name}
                        </h3>

                        {!folder.is_active ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                            Archived
                          </span>
                        ) : null}

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
                            }}
                          >
                            <Pencil className="size-3" />
                            <span className="sr-only">Edit folder {folder.name}</span>
                          </Button>
                        ) : null}
                      </div>

                      {folderLists.length > 0 ? (
                        <ListRows
                          lists={folderLists}
                          openCounts={openCounts}
                          onEdit={editList}
                        />
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
              key={editingList?.id ?? "new"}
              list={editingList}
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
                editingGroup
                  ? (listsByGroup.get(`${editingGroup.department_id}:${editingGroup.id}`) ?? [])
                      .length
                  : 0
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
    <ul className="overflow-hidden rounded-lg border">
      {lists.map((list) => (
        <li
          key={list.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b p-3 last:border-0"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{list.name}</span>
              {/* Never colour alone — the word carries the state. */}
              {!list.is_active ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                  Archived
                </span>
              ) : null}
              {list.form_id ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                  From a form
                </span>
              ) : null}
            </div>
            {list.description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{list.description}</p>
            ) : null}
          </div>

          <span className="shrink-0 text-2xs text-muted-foreground">
            {openCounts[list.id] ?? 0} open
          </span>

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
  departments,
  groups,
  openCount,
  onDone,
}: {
  list: ListRow | null;
  departments: Department[];
  groups: GroupRow[];
  openCount: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [departmentId, setDepartmentId] = useState(list?.department_id ?? departments[0]!.id);
  const [groupId, setGroupId] = useState(list?.group_id ?? NO_FOLDER);
  const [isActive, setIsActive] = useState(list?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(list?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  /** A form's inbox list is locked to the reserved folder and to being available. */
  const isFormList = Boolean(list?.form_id);

  /*
   * Only this department's own folders, and never the reserved one.
   *
   * Offering another department's would be offering a guaranteed rejection —
   * `vizserve_pms_lists_group_guard` answers "That folder belongs to another
   * department." Offering Client Requests would be worse, because the refusal
   * arrives only after the whole form is filled in.
   */
  const folders = groups.filter(
    (group) => group.department_id === departmentId && !group.is_system && group.is_active,
  );

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
  const departmentItems = Object.fromEntries(
    departments.map((department) => [department.id, department.name]),
  );

  const folderItems = {
    [NO_FOLDER]: "No folder — top level",
    ...Object.fromEntries(folders.map((folder) => [folder.id, folder.name])),
  };

  function submit() {
    setError(null);

    startTransition(async () => {
      const result = await saveList(list?.id ?? null, {
        department_id: departmentId,
        name,
        description,
        is_active: isActive,
        sort_order: sortOrder,
        group_id: groupId === NO_FOLDER ? null : groupId,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success(list ? "List saved" : "List created");
      onDone();
      router.refresh();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{list ? "Edit list" : "New list"}</DialogTitle>
        <DialogDescription>
          Lists group a department&apos;s work. Tasks can sit in one, or in none.
        </DialogDescription>
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
              disabled={Boolean(list)}
            >
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
              <p className="text-xs text-muted-foreground">
                Fixed — tasks in this list belong to this department.
              </p>
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
            disabled={isFormList || folders.length === 0}
          >
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
                : "A list can sit in a folder or on its own."}
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
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending} disabled={name.trim().length === 0}>
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
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [departmentId, setDepartmentId] = useState(group?.department_id ?? departments[0]!.id);
  const [isActive, setIsActive] = useState(group?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(group?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  // Without this the trigger shows a bare UUID — see the note in ListForm.
  const departmentItems = Object.fromEntries(
    departments.map((department) => [department.id, department.name]),
  );

  function submit() {
    setError(null);

    startTransition(async () => {
      const result = await saveTaskGroup(group?.id ?? null, {
        department_id: departmentId,
        name,
        description,
        is_active: isActive,
        sort_order: sortOrder,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success(group ? "Folder saved" : "Folder created");
      onDone();
      router.refresh();
    });
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
              disabled={Boolean(group)}
            >
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
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending} disabled={name.trim().length === 0}>
          {group ? "Save" : "Create folder"}
        </Button>
      </DialogFooter>
    </>
  );
}

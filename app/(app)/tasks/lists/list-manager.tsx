"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
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

import { saveList } from "../actions";

type ListRow = {
  id: string;
  name: string;
  description: string;
  department_id: string;
  is_active: boolean;
  sort_order: number;
};

type Department = { id: string; name: string };

export function ListManager({
  lists,
  departments,
  openCounts,
}: {
  lists: ListRow[];
  departments: Department[];
  openCounts: Record<string, number>;
}) {
  const [editing, setEditing] = useState<ListRow | null>(null);
  const [open, setOpen] = useState(false);

  const departmentName = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );

  // Grouped by department, because a list only means anything inside one — two
  // teams may both have a "Collateral" list and they are different lists.
  const grouped = useMemo(() => {
    const byDepartment = new Map<string, ListRow[]>();
    for (const list of lists) {
      const bucket = byDepartment.get(list.department_id) ?? [];
      bucket.push(list);
      byDepartment.set(list.department_id, bucket);
    }
    return byDepartment;
  }, [lists]);

  function create() {
    setEditing(null);
    setOpen(true);
  }

  function edit(list: ListRow) {
    setEditing(list);
    setOpen(true);
  }

  if (departments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm font-medium">You do not lead a department</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Lists belong to the department that uses them. An admin can add you to one.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={create}>
          <Plus />
          New list
        </Button>
      </div>

      {lists.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No lists yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Tasks work fine without one. Add lists when a department has enough going on that
            &ldquo;which project is this?&rdquo; becomes a real question.
          </p>
          <Button size="sm" className="mt-4" onClick={create}>
            Create the first list
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          {departments.map((department) => {
            const departmentLists = grouped.get(department.id) ?? [];
            if (departmentLists.length === 0) return null;

            return (
              <section key={department.id}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {department.name}
                </h2>
                <ul className="overflow-hidden rounded-lg border">
                  {departmentLists.map((list) => (
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
                        </div>
                        {list.description ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">{list.description}</p>
                        ) : null}
                      </div>

                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {openCounts[list.id] ?? 0} open
                      </span>

                      <Button variant="ghost" size="sm" onClick={() => edit(list)}>
                        <Pencil />
                        <span className="sr-only">Edit {list.name}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          {/* Keyed and unmounted while closed, so the fields are seeded rather
              than synced — editing one list then another must not carry the
              first one's name across. */}
          {open ? (
            <ListForm
              key={editing?.id ?? "new"}
              list={editing}
              departments={departments}
              openCount={editing ? (openCounts[editing.id] ?? 0) : 0}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ListForm({
  list,
  departments,
  openCount,
  onDone,
}: {
  list: ListRow | null;
  departments: Department[];
  openCount: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [departmentId, setDepartmentId] = useState(list?.department_id ?? departments[0]!.id);
  const [isActive, setIsActive] = useState(list?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(list?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);

    startTransition(async () => {
      const result = await saveList(list?.id ?? null, {
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
              value={departmentId}
              onValueChange={setDepartmentId}
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

        {list ? (
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <Label htmlFor="is_active">Available</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isActive
                  ? "Offered when assigning work."
                  : "Hidden from the pickers. Tasks already in it stay put."}
              </p>
              {!isActive && openCount > 0 ? (
                <p className="mt-1 text-xs text-warning">
                  {openCount} open {openCount === 1 ? "task is" : "tasks are"} still in this list.
                </p>
              ) : null}
            </div>
            <Switch id="is_active" checked={isActive} onCheckedChange={setIsActive} />
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

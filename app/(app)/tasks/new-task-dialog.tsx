"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Textarea } from "@/components/ui/textarea";

import { createTask } from "./actions";

/**
 * P3-12 — a task with no request behind it.
 *
 * Amier, 33:20. Plenty of real work never comes through a client form, and a
 * system that can only represent form-shaped work gets abandoned for the rest —
 * which is how the team ends up back in ClickUp for half their tickets.
 */

type Department = { id: string; name: string };
type Person = {
  id: string;
  full_name: string;
  primary_department_id: string | null;
};
type List = { id: string; name: string; department_id: string };

const NONE = "__none__";

/**
 * Three shapes, one dialog.
 *
 * `toolbar` is the page action. `column` and `row` are the in-place adds on the
 * board and on the list's Open group — quiet, full-width, ghosted, so the
 * affordance sits where the task will appear without competing with the cards
 * above it. All three open the same form; nothing about what gets created
 * changes with the look.
 */
const TRIGGER: Record<"toolbar" | "column" | "row", { label: string; button: React.ReactElement }> =
  {
    toolbar: { label: "New task", button: <Button size="sm" /> },
    column: {
      label: "Add task",
      button: (
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
        />
      ),
    },
    row: {
      label: "Add task",
      button: (
        <Button
          variant="ghost"
          size="xs"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
        />
      ),
    },
  };

export function NewTaskDialog({
  departments,
  people,
  lists,
  defaultDepartmentId,
  trigger = "toolbar",
}: {
  departments: Department[];
  people: Person[];
  lists: List[];
  defaultDepartmentId: string;
  trigger?: "toolbar" | "column" | "row";
}) {
  const [open, setOpen] = useState(false);
  const shape = TRIGGER[trigger];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={shape.button}>
        <Plus />
        {shape.label}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        {/* Unmounted while closed, so the fields are seeded on open rather than
            synced by an effect — the same reason as the user editor. */}
        {open ? (
          <TaskForm
            departments={departments}
            people={people}
            lists={lists}
            defaultDepartmentId={defaultDepartmentId}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TaskForm({
  departments,
  people,
  lists,
  defaultDepartmentId,
  onDone,
}: {
  departments: Department[];
  people: Person[];
  lists: List[];
  defaultDepartmentId: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [departmentId, setDepartmentId] = useState(defaultDepartmentId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>(NONE);
  const [qaAssigneeId, setQaAssigneeId] = useState<string>(NONE);
  const [dueDate, setDueDate] = useState("");
  const [listId, setListId] = useState<string>(NONE);
  const [formError, setFormError] = useState<string | null>(null);

  // Narrowed to the chosen department, because the server refuses an assignee
  // from elsewhere — offering them would be offering a guaranteed failure.
  const candidates = useMemo(
    () => people.filter((person) => person.primary_department_id === departmentId),
    [people, departmentId],
  );

  const departmentLists = useMemo(
    () => lists.filter((list) => list.department_id === departmentId),
    [lists, departmentId],
  );

  function changeDepartment(next: string) {
    setDepartmentId(next);
    // Clear anything now pointing at the old department, rather than sending a
    // stale id the server will reject.
    setAssigneeId(NONE);
    setQaAssigneeId(NONE);
    setListId(NONE);
  }

  function submit() {
    setFormError(null);

    startTransition(async () => {
      const result = await createTask({
        department_id: departmentId,
        title,
        description,
        assignee_id: assigneeId === NONE ? null : assigneeId,
        qa_assignee_id: qaAssigneeId === NONE ? null : qaAssigneeId,
        due_date: dueDate,
        list_id: listId === NONE ? null : listId,
      });

      if (!result.ok) {
        setFormError(result.error);
        return;
      }

      toast.success("Task created");
      onDone();
      router.push(`/tasks/${result.data.taskId}`);
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>
          Work that did not come through a client form. It starts as Open and follows the same
          stages as everything else.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="department">Department</Label>
            <Select
              value={departmentId}
              onValueChange={(value) => value !== null && changeDepartment(value)}
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="due">Due date</Label>
            <Input
              id="due"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="assignee">Person in charge</Label>
            <Select
              value={assigneeId}
              onValueChange={(value) => value !== null && setAssigneeId(value)}
            >
              <SelectTrigger id="assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {candidates.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {candidates.length === 0 ? (
              <p className="text-xs text-warning">Nobody belongs to this department yet.</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="qa">QA reviewer</Label>
            <Select
              value={qaAssigneeId}
              onValueChange={(value) => value !== null && setQaAssigneeId(value)}
            >
              <SelectTrigger id="qa">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No QA reviewer</SelectItem>
                {candidates.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {departmentLists.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor="list">List</Label>
            <Select value={listId} onValueChange={(value) => value !== null && setListId(value)}>
              <SelectTrigger id="list">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No list</SelectItem>
                {departmentLists.map((list) => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {formError ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {formError}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending} disabled={title.trim().length === 0}>
          Create task
        </Button>
      </DialogFooter>
    </>
  );
}

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
import { DatePicker } from "@/components/ui/date-picker";
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

import type { TaskPriority } from "@/lib/schemas/tasks";

import { createTask } from "./actions";
import { EstimateField } from "./estimate-field";
import { PriorityPicker } from "./priority-picker";

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
  const [startDate, setStartDate] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [listId, setListId] = useState<string>(NONE);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
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

  /*
   * value → label maps for the four Selects below.
   *
   * ⚠️ Base UI's SelectValue renders the RAW VALUE unless the Select root is
   * given `items`. The `<SelectItem>` children fill the POPUP; this fills the
   * TRIGGER. Without it the closed controls showed a bare UUID, or the literal
   * "__none__", where a name belongs.
   */
  const departmentItems = Object.fromEntries(
    departments.map((department) => [department.id, department.name]),
  );
  const peopleItems = Object.fromEntries(
    candidates.map((person) => [person.id, person.full_name]),
  );
  const assigneeItems = { [NONE]: "Unassigned", ...peopleItems };
  const qaItems = { [NONE]: "No QA reviewer", ...peopleItems };
  const listItems = {
    [NONE]: "No list",
    ...Object.fromEntries(departmentLists.map((list) => [list.id, list.name])),
  };

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
        start_date: startDate,
        list_id: listId === NONE ? null : listId,
        priority,
        // K5 — captured here so a task arrives complete rather than needing four
        // edits on the row afterwards.
        estimate_minutes: estimate,
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
              items={departmentItems}
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
            <Label htmlFor="start">Start date</Label>
            <DatePicker
              id="start"
              value={startDate}
              onChange={(value) => setStartDate(value ?? "")}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="due">Due date</Label>
            <DatePicker
              id="due"
              value={dueDate}
              onChange={(value) => setDueDate(value ?? "")}
              min={startDate || undefined}
            />
          </div>

          <EstimateField value={estimate} onChange={setEstimate} disabled={pending} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="assignee">Person in charge</Label>
            <Select
              items={assigneeItems}
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
              items={qaItems}
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
            <Select
              items={listItems}
              value={listId}
              onValueChange={(value) => value !== null && setListId(value)}
            >
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

        <PriorityPicker value={priority} onChange={setPriority} disabled={pending} />

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

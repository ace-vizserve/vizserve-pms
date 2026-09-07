"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "@/components/ui/toast";

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
import { RichTextEditor } from "@/components/ui/rich-text-editor";

import type { TaskPriority } from "@/lib/schemas/tasks";

import { PeoplePicker } from "./assignees";
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
  defaultListId = null,
  trigger = "toolbar",
}: {
  departments: Department[];
  people: Person[];
  lists: List[];
  defaultDepartmentId: string;
  /**
   * The list the reader is already filtered to, from `?list=`. See the note in
   * `new-task-button.tsx`: without it a task created while looking at a list
   * was filed unlisted, and simply did not appear where it was made.
   */
  defaultListId?: string | null;
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
            defaultListId={defaultListId}
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
  defaultListId = null,
  onDone,
}: {
  departments: Department[];
  people: Person[];
  lists: List[];
  defaultDepartmentId: string;
  defaultListId?: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [departmentId, setDepartmentId] = useState(defaultDepartmentId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>(NONE);
  const [qaAssigneeId, setQaAssigneeId] = useState<string>(NONE);
  /**
   * P7-13 — everyone else on the task.
   *
   * Separate from the person in charge above and not a multi-select version of
   * it: one of these is the name the task is FILED under and the other is who is
   * doing the work. Collapsing them is what makes "assigned to the team" mean
   * assigned to nobody.
   */
  const [extraAssigneeIds, setExtraAssigneeIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  /*
   * Seeded from `?list=`, but ONLY when it is genuinely one of the options. A
   * URL is something somebody can type, and a lead reads lists across every
   * department they lead — so an id that is not in `lists` falls back to NONE
   * rather than pre-selecting something the server would refuse.
   */
  const [listId, setListId] = useState<string>(
    defaultListId && lists.some((list) => list.id === defaultListId) ? defaultListId : NONE,
  );
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
  /**
   * The person in charge is not offered as somebody to ALSO add — the create
   * function already puts them on the join table. Shown-but-ticked is the right
   * shape for a picker on a task that exists (see `AssigneePicker`); on a form
   * where that person is chosen two controls up, listing them again is just a
   * second way to say the same thing.
   */
  const otherPeople = useMemo(
    () => candidates.filter((person) => person.id !== assigneeId),
    [candidates, assigneeId],
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
    setExtraAssigneeIds([]);
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
        // Added one at a time after the row exists — `create_task` takes one
        // assignee and `vizserve_pms_add_task_assignee` is the only way into
        // the join table.
        extra_assignee_ids: extraAssigneeIds,
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
          {/* No `htmlFor` — the editor's input is a contenteditable, which is
              not a labelable element. It carries the same words as its
              `aria-label`. */}
          <Label>Description</Label>
          <RichTextEditor
            ariaLabel="Description"
            value={description}
            onChange={setDescription}
            minHeight="min-h-24"
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
              onValueChange={(value) => {
                if (value === null) return;
                setAssigneeId(value);
                // Promoting somebody already on the list to person in charge
                // takes them off it — they are on the task either way, and
                // leaving them in both places would show their monogram twice.
                setExtraAssigneeIds((current) => current.filter((id) => id !== value));
              }}
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

        {/* P7-13. Its own row rather than a third column, because it is not a
            third dropdown — it holds any number of people and needs the width to
            say so. */}
        <div className="space-y-2">
          <Label htmlFor="also-working">Also working on it</Label>
          <PeoplePicker
            value={extraAssigneeIds}
            candidates={otherPeople}
            onChange={setExtraAssigneeIds}
            disabled={pending || candidates.length === 0}
            triggerClassName="flex h-10 w-full items-center gap-2 rounded-md border bg-card grade-raised px-3 text-sm shadow-raised hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="text-xs text-muted-foreground">
            {/* Said here as well as in the picker's own footer: this is where
                somebody decides it, and the consequence should not be one click
                further in. */}
            Optional. Everyone added can see the task, edit it, log time against it and move it —
            the person in charge stays the one name it is filed under.
          </p>
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

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDuration } from "@/lib/dates";
import { fromMinutes, toMinutes } from "@/lib/schemas/timesheet";

import { deleteTimeEntry, updateTimeEntry } from "./actions";
import type { PickableTask } from "./log-time-form";

export type WeekEntry = {
  id: string;
  task_id: string;
  work_date: string;
  minutes: number;
  note: string | null;
  taskTitle: string;
};

/**
 * P6-03 — one day's entries, editable in place.
 *
 * Edited here rather than on a separate screen. A timesheet is corrected far
 * more often than it is read — the number that is wrong is wrong the moment you
 * see it — and a round trip to another page to change 90 minutes to 120 is how
 * people stop correcting them at all.
 *
 * Deletion is unguarded on purpose. There is no confirmation dialogue because
 * the row is one field and re-entering it costs less than reading a modal, and
 * the audit question this table answers is "how long did the work take", not
 * "what did somebody once type".
 */
export function WeekEntries({
  entries,
  tasks,
  maxDate,
}: {
  entries: WeekEntry[];
  tasks: PickableTask[];
  maxDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <ul className="divide-y">
      {entries.map((entry) =>
        editing === entry.id ? (
          <li key={entry.id} className="p-3">
            <EntryEditor
              entry={entry}
              tasks={tasks}
              maxDate={maxDate}
              pending={pending}
              onCancel={() => setEditing(null)}
              onSave={(next) => {
                startTransition(async () => {
                  const result = await updateTimeEntry({ id: entry.id, ...next });
                  if (!result.ok) {
                    toast.error(result.error);
                    return;
                  }
                  toast.success("Updated.");
                  setEditing(null);
                  router.refresh();
                });
              }}
            />
          </li>
        ) : (
          <li key={entry.id} className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{entry.taskTitle}</p>
              {entry.note ? (
                <p className="truncate text-xs text-muted-foreground">{entry.note}</p>
              ) : null}
            </div>

            <span className="shrink-0 text-sm font-medium tabular-nums">
              {formatDuration(entry.minutes)}
            </span>

            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              disabled={pending}
              onClick={() => setEditing(entry.id)}
            >
              <Pencil />
              <span className="sr-only">Edit {entry.taskTitle}</span>
            </Button>

            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteTimeEntry(entry.id);
                  if (!result.ok) {
                    toast.error(result.error);
                    return;
                  }
                  toast.success("Removed.");
                  router.refresh();
                })
              }
            >
              <Trash2 />
              <span className="sr-only">Remove {entry.taskTitle}</span>
            </Button>
          </li>
        ),
      )}
    </ul>
  );
}

function EntryEditor({
  entry,
  tasks,
  maxDate,
  pending,
  onCancel,
  onSave,
}: {
  entry: WeekEntry;
  tasks: PickableTask[];
  maxDate: string;
  pending: boolean;
  onCancel: () => void;
  onSave: (next: {
    task_id: string;
    work_date: string;
    minutes: number;
    note: string | null;
  }) => void;
}) {
  const initial = fromMinutes(entry.minutes);

  const [taskId, setTaskId] = useState(entry.task_id);
  const [workDate, setWorkDate] = useState(entry.work_date);
  const [hours, setHours] = useState(initial.hours);
  const [minutes, setMinutes] = useState(initial.minutes);
  const [note, setNote] = useState(entry.note ?? "");

  // The entry's own task is added to the list even when it is finished and no
  // longer offered for new entries. Without it, editing the note on an hour
  // logged to a completed task would silently re-point that hour at whatever
  // task happened to be first in the picker.
  const options: PickableTask[] = tasks.some((task) => task.id === entry.task_id)
    ? tasks
    : [{ id: entry.task_id, title: entry.taskTitle }, ...tasks];

  const items: Record<string, string> = Object.fromEntries(
    options.map((task) => [task.id, task.title]),
  );

  const total = toMinutes(hours, minutes);

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="space-y-1">
          <Label htmlFor={`edit-task-${entry.id}`} className="text-xs text-muted-foreground">
            Task
          </Label>
          <Select items={items} value={taskId} onValueChange={(value) => value && setTaskId(value)}>
            <SelectTrigger id={`edit-task-${entry.id}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((task) => (
                <SelectItem key={task.id} value={task.id}>
                  {task.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-hours-${entry.id}`} className="text-xs text-muted-foreground">
            Hours
          </Label>
          <Input
            id={`edit-hours-${entry.id}`}
            type="number"
            min={0}
            max={24}
            className="w-20"
            value={hours}
            disabled={pending}
            onChange={(event) => setHours(event.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-minutes-${entry.id}`} className="text-xs text-muted-foreground">
            Minutes
          </Label>
          <Input
            id={`edit-minutes-${entry.id}`}
            type="number"
            min={0}
            max={59}
            step={5}
            className="w-20"
            value={minutes}
            disabled={pending}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`edit-date-${entry.id}`} className="text-xs text-muted-foreground">
            Date
          </Label>
          <Input
            id={`edit-date-${entry.id}`}
            type="date"
            value={workDate}
            max={maxDate}
            disabled={pending}
            onChange={(event) => setWorkDate(event.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor={`edit-note-${entry.id}`} className="text-xs text-muted-foreground">
            Note
          </Label>
          <Input
            id={`edit-note-${entry.id}`}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          loading={pending}
          disabled={total === null || total <= 0}
          onClick={() =>
            total !== null &&
            onSave({
              task_id: taskId,
              work_date: workDate,
              minutes: total,
              note: note.trim() ? note : null,
            })
          }
        >
          <Check />
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          <X />
          Cancel
        </Button>
      </div>
    </div>
  );
}

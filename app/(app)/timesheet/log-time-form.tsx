"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
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
import { toMinutes } from "@/lib/schemas/timesheet";

import { logTime } from "./actions";

export type PickableTask = { id: string; title: string };

/**
 * P6-02 — the entry form.
 *
 * A SELECT, not a text field. That is the rule (Amier, 33:20: "hindi ka rin
 * pwede-pwede mag-log ng gusto mo"), and the reason the whole feature is worth
 * building — hours attached to a free-text label cannot be added up against the
 * task they belong to, which is the one number this module exists to produce.
 */
export function LogTimeForm({
  tasks,
  defaultDate,
  maxDate,
}: {
  tasks: PickableTask[];
  defaultDate: string;
  /** Today. The policy refuses a future date; this stops it being typed at all. */
  maxDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [taskId, setTaskId] = useState<string | null>(null);
  const [workDate, setWorkDate] = useState(defaultDate);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Base UI's Select.Value renders the raw value unless the Root is given an
  // items map — without this the trigger shows a UUID.
  const taskItems: Record<string, string> = Object.fromEntries(
    tasks.map((task) => [task.id, task.title]),
  );

  const total = toMinutes(hours, minutes);

  function submit() {
    setError(null);

    // Checked here so the message names the field. The server re-checks all
    // three, and the database re-checks two of them under that.
    if (!taskId) {
      setError("Pick the task this time went to.");
      return;
    }
    if (total === null || total <= 0) {
      setError("How long did it take? Hours, minutes, or both.");
      return;
    }

    startTransition(async () => {
      const result = await logTime({
        task_id: taskId,
        work_date: workDate,
        minutes: total,
        note: note.trim() ? note : null,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success("Logged.");
      // The task and the date stay put. Somebody logging a week of catch-up
      // enters four entries against the same task in a row, and clearing the
      // picker each time makes them re-pick it each time.
      setHours("");
      setMinutes("");
      setNote("");
      router.refresh();
    });
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-xl bg-card p-3 text-xs text-muted-foreground ring-1 ring-foreground/10">
        <p className="mb-1 text-sm font-medium text-foreground">Nothing to log against</p>
        <p>
          You are not the PIC or the QA reviewer on any open task. Time is logged against a task, so
          there is nothing to attach hours to yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <div className="space-y-1">
        <Label htmlFor="ts-task" className="text-xs text-muted-foreground">
          Task
        </Label>
        <Select items={taskItems} value={taskId} onValueChange={setTaskId}>
          <SelectTrigger id="ts-task" className="w-full">
            <SelectValue placeholder="Pick a task" />
          </SelectTrigger>
          <SelectContent>
            {tasks.map((task) => (
              <SelectItem key={task.id} value={task.id}>
                {task.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="ts-date" className="text-xs text-muted-foreground">
          Date
        </Label>
        <Input
          id="ts-date"
          type="date"
          value={workDate}
          max={maxDate}
          disabled={pending}
          onChange={(event) => setWorkDate(event.target.value)}
        />
      </div>

      {/* Hours and minutes as two fields rather than one decimal. "1.5" reads as
          an hour and five minutes to about half the people who type it, and the
          half who are wrong never find out. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="ts-hours" className="text-xs text-muted-foreground">
            Hours
          </Label>
          <Input
            id="ts-hours"
            type="number"
            inputMode="numeric"
            min={0}
            max={24}
            placeholder="0"
            value={hours}
            disabled={pending}
            onChange={(event) => setHours(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ts-minutes" className="text-xs text-muted-foreground">
            Minutes
          </Label>
          <Input
            id="ts-minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={5}
            placeholder="0"
            value={minutes}
            disabled={pending}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="ts-note" className="text-xs text-muted-foreground">
          Note <span className="text-2xs">(optional)</span>
        </Label>
        <Input
          id="ts-note"
          placeholder="e.g. second round of revisions"
          value={note}
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <Button className="mt-1 w-full" loading={pending} onClick={submit}>
        <Plus />
        Log time
      </Button>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

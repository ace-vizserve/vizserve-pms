"use client";

import { Repeat } from "lucide-react";

import { toast } from "@/components/ui/toast";
import { Label } from "@/components/ui/label";
import { formatDate, todayInAppZone } from "@/lib/dates";
import {
  RECURRENCE_FREQUENCIES,
  RECURRENCE_LABELS,
  RECURRENCE_LANDING_STATUSES,
  previewNextCopy,
  type RecurrenceFrequency,
  type RecurrenceLandingStatus,
} from "@/lib/recurrence";
import { TASK_STATUS_LABELS } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { setTaskRecurrence } from "./writes";

/**
 * P15-10 — "Repeat" in the new-task dialogs. The same pressed-button group as
 * `PriorityPicker`, so the two fields read as one family.
 *
 * The schedule is saved AFTER the task exists (`saveRepeatAfterCreate`), the
 * way start date and estimate are: the create functions keep their signatures
 * (P7-14's "dance" avoided), and a task that was created but whose schedule
 * failed is still a task — the toast says which half happened.
 */
export type RepeatChoice = { frequency: RecurrenceFrequency | null; landing: RecurrenceLandingStatus };

export const NO_REPEAT: RepeatChoice = { frequency: null, landing: "ONGOING" };

const BUTTON = cn(
  "inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export function RepeatPicker({
  value,
  onChange,
  startDate,
  dueDate,
  disabled,
}: {
  value: RepeatChoice;
  onChange: (next: RepeatChoice) => void;
  startDate: string | null;
  dueDate: string | null;
  disabled?: boolean;
}) {
  const next = value.frequency
    ? previewNextCopy(value.frequency, { start_date: startDate, due_date: dueDate }, todayInAppZone())
    : null;

  return (
    <div className="space-y-2">
      <Label>Repeat</Label>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repeat">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={value.frequency === null}
          onClick={() => onChange({ ...value, frequency: null })}
          className={cn(BUTTON, value.frequency === null ? "border-primary bg-accent text-accent-foreground" : "hover:bg-accent/50")}>
          Doesn&apos;t repeat
        </button>
        {RECURRENCE_FREQUENCIES.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={value.frequency === option}
            onClick={() => onChange({ ...value, frequency: option })}
            className={cn(BUTTON, value.frequency === option ? "border-primary bg-accent text-accent-foreground" : "hover:bg-accent/50")}>
            <Repeat className="size-3.5 text-primary" aria-hidden />
            {RECURRENCE_LABELS[option]}
          </button>
        ))}
      </div>

      {value.frequency ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            New copy starts as
            {RECURRENCE_LANDING_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                disabled={disabled}
                aria-pressed={value.landing === status}
                onClick={() => onChange({ ...value, landing: status })}
                className={cn(
                  "rounded-sm border px-2 py-0.5",
                  value.landing === status ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-accent/50",
                )}>
                {TASK_STATUS_LABELS[status]}
              </button>
            ))}
          </span>
          {next ? (
            <span>
              Next copy{" "}
              {next.start_date && next.due_date && next.start_date !== next.due_date
                ? `${formatDate(next.start_date)} – ${formatDate(next.due_date)}`
                : formatDate(next.start_date ?? next.due_date ?? next.period)}
              ; this one is marked Completed then.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** After a create succeeds: save the schedule, and say so if it did not stick. */
export async function saveRepeatAfterCreate(taskId: string, choice: RepeatChoice): Promise<void> {
  if (!choice.frequency) return;
  const result = await setTaskRecurrence({ task_id: taskId, frequency: choice.frequency, landing_status: choice.landing });
  if (!result.ok) toast.error(`The task was created, but its repeat schedule was not saved: ${result.error}`);
}

"use client";

import { Flag, Ban } from "lucide-react";

import { Label } from "@/components/ui/label";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

/**
 * P7-11 — how urgent is this?
 *
 * FIVE OPTIONS FROM FOUR VALUES. "Clear" is the fifth and it does not mean
 * Normal — it means no priority on this task, which is what most tasks have and
 * what every task starts as. The column is nullable precisely so that stays
 * expressible after a priority has been set once.
 *
 * Highest first, unlike `TASK_PRIORITIES` itself. That constant is declared
 * low→high because Postgres compares enums by declaration order and every sort
 * in the app depends on it; a person reading a picker scans from the most
 * severe down. Reversing here rather than there keeps the SQL-facing constant
 * the authority.
 *
 * The flag is DECORATION. The reference this came from distinguishes the four
 * by colour alone — identical flag shapes in red, yellow, blue and grey — which
 * this app does not do. Every option carries its word, and the word is what
 * survives if anything has to go.
 */
const FLAG_TONE: Record<TaskPriority, string> = {
  URGENT: "text-destructive",
  HIGH: "text-warning",
  NORMAL: "text-info",
  LOW: "text-foreground-faint",
};

export function PriorityPicker({
  value,
  onChange,
  disabled,
}: {
  value: TaskPriority | null;
  onChange: (next: TaskPriority | null) => void;
  disabled?: boolean;
}) {
  const options = [...TASK_PRIORITIES].reverse();

  return (
    <div className="space-y-2">
      <Label>Priority</Label>

      {/* A radio group in spirit: one choice, all options visible. `aria-pressed`
          rather than real radios because "Clear" is not a fifth value — it is
          the absence of the other four, and a radio named "none" would put it
          in the same class as them. */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Priority">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium",
              "disabled:cursor-not-allowed disabled:opacity-50",
              value === option
                ? "border-primary bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
            )}
          >
            <Flag className={cn("size-3.5", FLAG_TONE[option])} aria-hidden />
            {TASK_PRIORITY_LABELS[option]}
          </button>
        ))}

        {/* Only offered once there is something to clear. A permanently visible
            "Clear" on a task that has no priority is a control that does
            nothing. */}
        {value !== null ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium",
              "text-muted-foreground hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <Ban className="size-3.5" aria-hidden />
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

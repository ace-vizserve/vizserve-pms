"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Flag, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TaskPriorityBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type TaskPriority,
} from "@/lib/schemas/tasks";
import { formatCellDuration, parseCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { updateTaskField } from "./actions";
import { ComposerCard, type Assignable } from "./task-composer";

/**
 * K3 — editing a task without opening it.
 *
 * Title, both dates, priority and the estimate, changed from the row or the
 * card. Every column here is already inside the column-level UPDATE grant
 * (`p7_11a` restated the list) and already scoped by the UPDATE policy, so there
 * is no backend behind any of it — which is exactly why it was worth doing.
 *
 * NOT `status`. It sits outside the grant on purpose and moves through
 * `TaskStatusSelect`, which is the only control that writes it.
 *
 * ⚠️ THE ONE RULE EVERY EDITOR HERE OBEYS: a policy-refused UPDATE is not an
 * error. It is success with zero rows (trap 9), and it is the bug the timesheet
 * already shipped twice. `updateTaskField` does the `.select()` and returns a
 * sentence; each editor below shows that sentence and PUTS THE OLD VALUE BACK.
 * An inline editor that keeps the new value on screen after a refusal is lying
 * about the state of the database.
 */

/** Shared: run a patch, report it, and roll the field back if it was refused. */
function usePatch(taskId: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function patch(
    field: Record<string, unknown>,
    { onRefused, success }: { onRefused: () => void; success?: string },
  ) {
    startTransition(async () => {
      const result = await updateTaskField(taskId, field);

      if (!result.ok) {
        // The row on screen still shows the new value at this point. Putting the
        // old one back is the whole contract of this function.
        onRefused();
        toast.error(result.error);
        return;
      }

      if (success) toast.success(success);
      router.refresh();
    });
  }

  return { patch, pending };
}

/**
 * The hover strip on a row or a card: rename, priority, add a subtask.
 *
 * All three are shortcuts to things that already exist — the title grant, the
 * P7-11 priority column and `vizserve_pms_set_task_parent` — so there is no new
 * backend under any of them.
 *
 * `opacity` on hover AND focus-within, never hover alone: a keyboard user
 * tabbing into an invisible button is the accessibility failure this pattern
 * usually ships with.
 *
 * AND THE WHOLE REVEAL IS INSIDE `any-hover: hover`, which is the OTHER half of
 * that failure and the one this shipped with. A touch device has no hover, so
 * `opacity-0` with a `group-hover` reveal left these controls permanently
 * invisible on a tablet — the subtask `+`, the rename and the priority flag,
 * unreachable on every row. Wrapping the hide and the reveal in the same query
 * means a pointer that cannot hover never gets either, and the strip is simply
 * always visible there.
 */
export function TaskRowActions({
  taskId,
  title,
  priority,
  assignable = [],
  children,
}: {
  taskId: string;
  title: string;
  priority: TaskPriority | null;
  /** Passed through to the subtask composer. */
  assignable?: Assignable[];
  /** Anything view-specific — the status control on a board card. */
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 transition-opacity",
        "[@media(any-hover:hover)]:opacity-0",
        "[@media(any-hover:hover)]:group-hover/task:opacity-100",
        // Focus stays outside the query: a keyboard is a fine pointer's
        // companion, but a tabbed-to control must appear on any device.
        "focus-within:opacity-100",
      )}
    >
      {children}
      <InlineTitle taskId={taskId} title={title} />
      <InlinePriority taskId={taskId} value={priority} iconOnly />
      <AddSubtask parentId={taskId} assignable={assignable} />
    </span>
  );
}

/** Rename in place. The pen opens a one-field popover; Enter commits. */
export function InlineTitle({ taskId, title }: { taskId: string; title: string }) {
  const { patch, pending } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(title);

  function commit() {
    const next = draft.trim();
    // Unchanged is not a save. An UPDATE that writes the same title still bumps
    // `updated_at` and still says "Renamed", which is a lie about what happened.
    if (!next || next === title) {
      setOpen(false);
      setDraft(title);
      return;
    }

    patch(
      { title: next },
      {
        success: "Renamed",
        onRefused: () => setDraft(title),
      },
    );
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(title);
      }}
    >
      <PopoverTrigger
        aria-label={`Rename ${title}`}
        title="Rename"
        className={ICON_BUTTON}
        disabled={pending}
      >
        <Pencil className="size-3.5" aria-hidden />
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={draft}
            disabled={pending}
            aria-label="Title"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                setDraft(title);
                setOpen(false);
              }
            }}
          />
          <Button size="icon" variant="ghost" onClick={commit} disabled={pending} aria-label="Save">
            <Check />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The priority chip IS the editor.
 *
 * `iconOnly` is the hover-strip shape, for the row where the chip already sits
 * beside the title and a second copy would be noise. Both render the same five
 * options — the four values and "Clear", which does not mean Normal: it means no
 * priority on this task, which is what most tasks have.
 */
export function InlinePriority({
  taskId,
  value,
  iconOnly = false,
}: {
  taskId: string;
  value: TaskPriority | null;
  iconOnly?: boolean;
}) {
  const { patch, pending } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(value);

  function choose(next: TaskPriority | null) {
    const previous = shown;
    setShown(next);
    setOpen(false);
    patch(
      { priority: next },
      {
        success: next === null ? "Priority cleared" : `Priority: ${TASK_PRIORITY_LABELS[next]}`,
        onRefused: () => setShown(previous),
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={shown ? `Priority: ${TASK_PRIORITY_LABELS[shown]}. Change it.` : "Set a priority"}
        title="Priority"
        disabled={pending}
        className={cn(
          iconOnly ? ICON_BUTTON : "rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {iconOnly ? (
          <Flag className={cn("size-3.5", shown ? FLAG_TONE[shown] : undefined)} aria-hidden />
        ) : shown ? (
          <TaskPriorityBadge priority={shown} className="h-5 px-1.5" />
        ) : (
          // A row with no priority still needs somewhere to click. A bare flag
          // outline says "settable" without claiming a value.
          <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
            <Flag className="size-3.5" aria-hidden />
            Set
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-44 p-1">
        {/* Highest first, unlike TASK_PRIORITIES itself — that constant is
            declared low→high because Postgres compares enums by declaration
            order, and a person reading a picker scans from the most severe
            down. */}
        {[...TASK_PRIORITIES].reverse().map((option) => (
          <button
            key={option}
            type="button"
            disabled={pending}
            onClick={() => choose(option)}
            className={cn(MENU_ROW, shown === option && "font-semibold")}
          >
            <Flag className={cn("size-3.5 shrink-0", FLAG_TONE[option])} aria-hidden />
            {TASK_PRIORITY_LABELS[option]}
            {shown === option ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
          </button>
        ))}

        {/* Only offered once there is something to clear. */}
        {shown !== null ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => choose(null)}
            className={cn(MENU_ROW, "text-muted-foreground")}
          >
            <Ban className="size-3.5 shrink-0" aria-hidden />
            Clear
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A date, edited where it is read.
 *
 * A native `<input type="date">` behind a text trigger rather than the calendar
 * primitive: the value is one field, the browser's own picker is keyboard- and
 * locale-correct for free, and this appears on every row of a long list where a
 * mounted calendar per row would be absurd.
 */
export function InlineDate({
  taskId,
  field,
  value,
  label,
  emphasis,
}: {
  taskId: string;
  field: "due_date" | "start_date";
  value: string | null;
  label: string;
  /** Overdue styling, decided by the caller — it knows whether the task is live. */
  emphasis?: boolean;
}) {
  const { patch, pending } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(value);

  function commit(next: string) {
    const previous = shown;
    // "" from a cleared input means no date. The action turns it into null.
    setShown(next || null);
    setOpen(false);
    patch(
      { [field]: next },
      {
        success: next ? `${label} ${formatDate(next)}` : `${label} cleared`,
        onRefused: () => setShown(previous),
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={shown ? `${label} ${formatDate(shown)}. Change it.` : `Set a ${label.toLowerCase()}`}
        disabled={pending}
        className={cn(
          "rounded-sm px-1 py-0.5 text-left tabular-nums",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
          emphasis ? "font-medium text-destructive" : "text-muted-foreground",
        )}
      >
        {shown ? formatDate(shown) : <span className="text-foreground-faint">—</span>}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto p-2">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            type="date"
            defaultValue={shown ?? ""}
            disabled={pending}
            aria-label={label}
            className="w-40"
            onChange={(event) => commit(event.target.value)}
          />
          {/* Clearing a date is a real instruction and a date input has no
              obvious way to express it — hence the explicit button. */}
          {shown ? (
            <Button
              size="icon"
              variant="ghost"
              disabled={pending}
              aria-label={`Clear the ${label.toLowerCase()}`}
              onClick={() => commit("")}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The estimate, on the row.
 *
 * Same parser as a timesheet cell (`2h`, `90m`, a bare `1.5` as hours), so the
 * estimate and the hours logged against it are written in one language. The
 * value is reformatted on commit, which is what makes a misread `1.5` visible
 * where it was typed.
 */
export function InlineEstimate({
  taskId,
  minutes,
}: {
  taskId: string;
  minutes: number | null;
}) {
  const { patch, pending } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(minutes);
  const [raw, setRaw] = useState(minutes === null ? "" : formatCellDuration(minutes));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = raw.trim();
    const previous = shown;

    if (!trimmed) {
      setError(null);
      setShown(null);
      setOpen(false);
      patch({ estimate_minutes: null }, { success: "Estimate cleared", onRefused: () => setShown(previous) });
      return;
    }

    const parsed = parseCellDuration(trimmed);
    if (parsed === null || parsed === 0) {
      setError("Try 2h, 90m or 1.5. A colon reads as a clock, so it is refused.");
      return;
    }

    setError(null);
    setShown(parsed);
    setRaw(formatCellDuration(parsed));
    setOpen(false);
    patch(
      { estimate_minutes: parsed },
      { success: `Estimate ${formatCellDuration(parsed)}`, onRefused: () => setShown(previous) },
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRaw(shown === null ? "" : formatCellDuration(shown));
          setError(null);
        }
      }}
    >
      <PopoverTrigger
        aria-label={shown === null ? "Set an estimate" : `Estimate ${formatCellDuration(shown)}. Change it.`}
        disabled={pending}
        className={cn(
          "rounded-sm px-1 py-0.5 tabular-nums text-muted-foreground",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {shown === null ? <span className="text-foreground-faint">—</span> : formatCellDuration(shown)}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56 p-2">
        <div className="space-y-1.5">
          <Input
            autoFocus
            value={raw}
            disabled={pending}
            placeholder="2h 30m"
            aria-label="Estimate"
            aria-invalid={error ? true : undefined}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") setOpen(false);
            }}
          />
          <p className={cn("text-2xs", error ? "text-destructive" : "text-muted-foreground")}>
            {error ?? "Hours and minutes. A plain number is hours. Empty clears it."}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * `+` — a subtask, one level deep.
 *
 * A SUBTASK IS JUST ANOTHER TASK, NESTED, so this opens the SAME composer the
 * foot of a group opens, with `parentId` set. It used to be a title-only box and
 * a `createSubtask` action of its own; two forms for "make a task" is how the
 * subtask one ends up without the fields the other one grew.
 *
 * P7-09 built `vizserve_pms_set_task_parent`, the one-level trigger and the
 * same-department rule, and no UI had ever called any of it — the board only
 * displayed a count.
 *
 * The parent decides two things the composer does not ask about: the department
 * (the trigger requires them to match) and, when the parent is personal work,
 * that the child is personal too — a subtask its owner could not close, hanging
 * off a parent they can, would be the wrong half of the P7-01 split. Both are
 * settled server-side in `quickAddTask`.
 */
export function AddSubtask({
  parentId,
  assignable = [],
}: {
  parentId: string;
  /** Empty is fine — the composer falls back to "Myself", which is most subtasks. */
  assignable?: Assignable[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Add a subtask" title="Add a subtask" className={ICON_BUTTON}>
        <Plus className="size-3.5" aria-hidden />
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-2">
        <div className="space-y-1.5">
          {/* The card shape rather than the row: a popover has no columns to line
              up under, and the stacked form is the one built for that. */}
          <ComposerCard
            status={INITIAL_TASK_STATUS}
            parentId={parentId}
            assignable={assignable}
            onCancel={() => setOpen(false)}
          />
          <p className="px-0.5 text-2xs text-muted-foreground">
            {/* Said out loud because the composer is otherwise identical to the
                one that adds a task at any stage, and this one cannot. */}
            Subtasks start in {TASK_STATUS_LABELS[INITIAL_TASK_STATUS]}, one level deep.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Progress, from the subtasks and nowhere else.
 *
 * P7-09 is one level deep and enforced by a trigger, so this is
 * `completed children / total children` — no column, no trigger, no stored
 * counter to drift out of step with the tasks it counts.
 *
 * A TASK WITH NO CHILDREN RENDERS NOTHING, not 0%. "No subtasks" and "no
 * subtasks done" are different facts, and a permanent 0% is the same lie as a
 * permanent zero on a dashboard tile.
 */
export function SubtaskProgress({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;

  const percent = Math.round((done / total) * 100);

  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${done} of ${total} subtasks done`}
    >
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn("block h-full rounded-full", done === total ? "bg-success" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </span>
      {/* Never the bar alone — the count is what survives greyscale, and it is
          also the more useful of the two at this size. */}
      <span className="text-2xs tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
    </span>
  );
}

const ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
  "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

const MENU_ROW = cn(
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
  "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

/** The flag is DECORATION — every option carries its word (see PriorityPicker). */
const FLAG_TONE: Record<TaskPriority, string> = {
  URGENT: "text-destructive",
  HIGH: "text-warning",
  NORMAL: "text-info",
  LOW: "text-foreground-faint",
};

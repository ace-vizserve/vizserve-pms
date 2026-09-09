"use client";

import { toast } from "@/components/ui/toast";
import { Ban, Check, Flag, Pencil, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, type ReactNode } from "react";

import { useOptimisticMove } from "./optimistic-move";

import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { toDateString } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";

import { TaskPriorityBadge } from "@/components/status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, parseDateOnly } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type TaskPriority,
} from "@/lib/schemas/tasks";
import { formatCellDuration, parseCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";
import { DeleteTaskDialog } from "./delete-task-dialog";

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

/**
 * Shared: write one field, report it, and re-read.
 *
 * ⚠️ IT OPENS NO TRANSITION, AND THAT IS THE POINT. Every caller is a form
 * action, and React already runs those in one — so this is simply awaited inside
 * the caller's own action. Two transitions was the bug: the optimistic value was
 * set in the form action's and awaited in this one, and `useOptimistic` shows
 * its value only while the transition THAT SET IT is pending, so it was dropped
 * a frame later and the chip waited for the server.
 *
 * One transition. Set, await, done — all in the caller.
 */
function usePatch(taskId: string) {
  const router = useRouter();

  /*
   * ⚠️ THE ROW IS PATCHED, NOT JUST THIS CONTROL'S OWN STATE.
   *
   * `InlinePriority` is rendered TWICE in one task row — beside the title and as
   * the priority column — and `TaskRowActions` reads the field a third time.
   * Three component instances with three separate local values: the one you
   * clicked moved and the other two sat on the old value until the server
   * answered. The optimistic value has to live on the ROW, held by the parent
   * that renders it and read by every cell as a prop.
   *
   * Null on the board and the task detail page, which render these controls with
   * no optimistic row list around them. There the control's own value is the
   * only one on screen, so nothing is missing.
   */
  const patchRow = useOptimisticMove();

  async function patch(field: Record<string, unknown>, { success }: { success?: string } = {}) {
    // The ROW, so every cell that renders this field moves together.
    patchRow?.({ kind: "patch", id: taskId, fields: field });

    const result = await updateTaskField(taskId, field);

    if (!result.ok) {
      // No rollback to write: React drops the optimistic value when the form
      // action finishes, and the field goes back to what the server still says.
      toast.error(result.error);
      return;
    }

    /*
     * ⚠️ THIS LOOKS LIKE A DUPLICATE ROUND TRIP AND IT IS NOT. IT HAS BEEN
     * REMOVED ONCE AND HAD TO BE PUT BACK. Read this before deleting it again —
     * the other four optimistic controls point here rather than repeating it:
     * `transition.tsx`, `assignees.tsx`, `delete-task-dialog.tsx` and
     * `task-composer.tsx`.
     *
     * THE CLAIM IT ANSWERS. `updateTaskField` calls `revalidatePath` itself, so
     * the fresh RSC payload comes back WITH the action's response and a second
     * fetch is pure waste. That is true of the RESPONSE and false of the TIMING,
     * which is the only thing that matters here.
     *
     * WHAT ACTUALLY HAPPENS, from Next 16's own action queue. The server action
     * reducer resolves the promise your `await` is sitting on — `resolve(
     * actionResult)` — and only THEN returns the next router state, which the
     * queue commits a further tick later. So the caller's async transition ends
     * BEFORE the new tree is on screen, `useOptimistic` drops its value the
     * instant the transition ends, and the field snaps back to the old server
     * value for that gap. Under PPR the gap can be a whole extra fetch, because
     * a seeded navigation may still have to go back for dynamic segments.
     *
     * The visible symptom, recorded when it shipped: THE TOAST ARRIVED BEFORE
     * THE UI CHANGED. The value you had just typed reverted, the toast said it
     * had saved, and then it changed again. `ded2244` restored this line in
     * eighteen files after `a64b06c` removed it.
     *
     * WHY THIS FIXES IT. `router.refresh()` puts a PENDING promise into the
     * router's state inside a transition, so the tree above suspends and React
     * cannot commit the optimistic-revert render until that promise settles —
     * transitions entangle. The optimistic value therefore holds until the real
     * one is there to replace it. The cost is one extra round trip; a field that
     * flickers back to its old value on every inline edit is worse.
     *
     * ⚠️ P12-02 LEFT ALL FIVE OF THESE IN PLACE FOR EXACTLY THIS REASON, and
     * removed only the sites with no optimistic value behind them
     * (`nav-personal.tsx`). THE REAL FIX IS PHASE 3: `useMutation` with
     * `onMutate`/`onSettled` against the query cache holds its own optimistic
     * value across the settle, so the hold stops needing a route render at all
     * and these lines go with `optimistic-move.tsx`.
     */
    router.refresh();

    if (success) toast.success(success);
  }

  return { patch };
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
  deletable = false,
  children,
}: {
  taskId: string;
  title: string;
  priority: TaskPriority | null;
  /** Passed through to the subtask composer. */
  assignable?: Assignable[];
  /**
   * P7-19. Whether to offer the trash at all.
   *
   * Computed by the PAGE, not here, because it needs the viewer's seat and the
   * task's `created_by` — and because the alternative is a control that always
   * opens a dialog only to say no. `nav-projects.tsx` records what that costs:
   * hiding a link protects nobody, but it stops offering a door that does not
   * open. The database refuses regardless; this is about not asking.
   */
  deletable?: boolean;
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
      )}>
      {children}
      <InlineTitle taskId={taskId} title={title} />
      <InlinePriority taskId={taskId} value={priority} iconOnly />
      <AddSubtask parentId={taskId} assignable={assignable} />
      {/* Last in the strip, and the only destructive thing in it. */}
      {deletable ? <DeleteTaskDialog taskId={taskId} title={title} /> : null}
    </span>
  );
}

/** Rename in place. The pen opens a one-field popover; Enter commits. */
export function InlineTitle({ taskId, title }: { taskId: string; title: string }) {
  const { patch } = usePatch(taskId);
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

    patch({ title: next }, { success: "Renamed" });
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(title);
      }}>
      <PopoverTrigger aria-label={`Rename ${title}`} title="Rename" className={ICON_BUTTON}>
        <Pencil className="size-3.5" aria-hidden />
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={draft}
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
          <Button size="icon" variant="ghost" onClick={commit} aria-label="Save">
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
  const { patch } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  /*
   * ⚠️ `useOptimistic`, NOT `useState`, AND THE REASON IS THE FORM ACTION.
   *
   * These rows are `formAction={() => choose(option)}` now, and React runs a
   * form action inside a TRANSITION. A plain `setState` in a transition is a
   * deferred update — React holds the old UI until the transition finishes — so
   * the chip stopped changing on click and only moved when the server answered.
   * The symptom was exact: the toast arrived first and the chip followed two
   * seconds later.
   *
   * `useOptimistic` is the one hook that renders immediately INSIDE a
   * transition. That is its whole purpose, and it is why the manual rollback
   * below is gone: React puts the old value back by itself when the transition
   * ends, refused or not.
   */
  const [shown, setShown] = useOptimistic(value);

  async function choose(next: TaskPriority | null) {
    setOpen(false);
    setShown(next);
    await patch(
      { priority: next },
      { success: next === null ? "Priority cleared" : `Priority: ${TASK_PRIORITY_LABELS[next]}` },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={shown ? `Priority: ${TASK_PRIORITY_LABELS[shown]}. Change it.` : "Set a priority"}
        title="Priority"
        className={cn(
          iconOnly ? ICON_BUTTON : "rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}>
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
        {/* One form around the menu; every row is a submit carrying its
            own formAction. React gives each its own transition. */}
        <form>
          {/* Highest first, unlike TASK_PRIORITIES itself — that constant is
            declared low→high because Postgres compares enums by declaration
            order, and a person reading a picker scans from the most severe
            down. */}
          {[...TASK_PRIORITIES].reverse().map((option) => (
            <button
              key={option}
              type="submit"
              formAction={() => choose(option)}
              className={cn(MENU_ROW, shown === option && "font-semibold")}>
              <Flag className={cn("size-3.5 shrink-0", FLAG_TONE[option])} aria-hidden />
              {TASK_PRIORITY_LABELS[option]}
              {shown === option ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
            </button>
          ))}

          {/* Only offered once there is something to clear. */}
          {shown !== null ? (
            <button type="submit" formAction={() => choose(null)} className={cn(MENU_ROW, "text-muted-foreground")}>
              <Ban className="size-3.5 shrink-0" aria-hidden />
              Clear
            </button>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A date, edited where it is read.
 *
 * ⚠️ THIS USED TO BE A NATIVE `<input type="date">`, on the reasoning that "a
 * mounted calendar per row would be absurd". The concern was right and the
 * conclusion was not: `PopoverContent` only mounts while it is open, so exactly
 * one calendar exists at a time no matter how long the list is.
 *
 * The calendar is rendered DIRECTLY rather than through `DatePicker`, because
 * this is already inside a Popover and nesting one inside another traps focus in
 * the wrong layer and dismisses both on a single Escape.
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
  const { patch } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  /*
   * ⚠️ `useOptimistic`, NOT `useState` — see the note on `InlinePriority`. The
   * rows here are form actions, and a plain setState inside a transition is a
   * DEFERRED update: React holds the old UI until the action finishes.
   */
  const [shown, setShown] = useOptimistic(value);

  async function commit(next: string) {
    // "" from a cleared input means no date. The action turns it into null.
    setOpen(false);
    setShown(next || null);
    await patch({ [field]: next }, { success: next ? `${label} ${formatDate(next)}` : `${label} cleared` });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={shown ? `${label} ${formatDate(shown)}. Change it.` : `Set a ${label.toLowerCase()}`}
        className={cn(
          "rounded-sm px-1 py-0.5 text-left tabular-nums",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
          emphasis ? "font-medium text-destructive" : "text-muted-foreground",
        )}>
        {shown ? formatDate(shown) : <span className="text-foreground-faint">—</span>}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto p-2">
        <div className="flex items-center gap-1.5">
          <Calendar
            mode="single"
            autoFocus
            aria-label={label}
            selected={shown ? (parseDateOnly(shown) ?? undefined) : undefined}
            defaultMonth={shown ? (parseDateOnly(shown) ?? undefined) : undefined}
            onSelect={(date) => date && commit(toDateString(date))}
          />
          {/* Clearing a date is a real instruction and a date input has no
              obvious way to express it — hence the explicit button. */}
          {shown ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Clear the ${label.toLowerCase()}`}
              onClick={() => commit("")}>
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
export function InlineEstimate({ taskId, minutes }: { taskId: string; minutes: number | null }) {
  const { patch } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  /*
   * ⚠️ `useOptimistic`, NOT `useState` — see the note on `InlinePriority`. The
   * rows here are form actions, and a plain setState inside a transition is a
   * DEFERRED update: React holds the old UI until the action finishes.
   */
  const [shown, setShown] = useOptimistic(minutes);
  const [raw, setRaw] = useState(minutes === null ? "" : formatCellDuration(minutes));
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    const trimmed = raw.trim();

    if (!trimmed) {
      setError(null);
      setOpen(false);
      setShown(null);
      await patch({ estimate_minutes: null }, { success: "Estimate cleared" });
      return;
    }

    const parsed = parseCellDuration(trimmed);
    if (parsed === null || parsed === 0) {
      setError("Try 2h, 90m or 1.5. A colon reads as a clock, so it is refused.");
      return;
    }

    setError(null);
    setRaw(formatCellDuration(parsed));
    setOpen(false);
    setShown(parsed);
    await patch({ estimate_minutes: parsed }, { success: `Estimate ${formatCellDuration(parsed)}` });
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
      }}>
      <PopoverTrigger
        aria-label={shown === null ? "Set an estimate" : `Estimate ${formatCellDuration(shown)}. Change it.`}
        className={cn(
          "rounded-sm px-1 py-0.5 tabular-nums text-muted-foreground",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}>
        {shown === null ? <span className="text-foreground-faint">—</span> : formatCellDuration(shown)}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56 p-2">
        <div className="space-y-1.5">
          <Input
            autoFocus
            value={raw}
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
 * The list a task is filed under, edited where it is read.
 *
 * P7-56 — the last of the task's properties that still needed a boxed `Select`
 * to change it, which is why the detail page's property block could not be a
 * row of plain values until now. Same shape as `InlinePriority`: the value IS
 * the trigger, and "No list" is offered as an option rather than as a separate
 * Clear, because a task with no list is the ordinary case and not a cleared one.
 */
export function InlineList({
  taskId,
  value,
  lists,
}: {
  taskId: string;
  value: string | null;
  lists: { id: string; name: string }[];
}) {
  const { patch } = usePatch(taskId);
  const [open, setOpen] = useState(false);
  /*
   * ⚠️ `useOptimistic`, NOT `useState` — see the note on `InlinePriority`. The
   * rows here are form actions, and a plain setState inside a transition is a
   * DEFERRED update: React holds the old UI until the action finishes.
   */
  const [shown, setShown] = useOptimistic(value);

  const nameOf = (id: string | null) => lists.find((list) => list.id === id)?.name ?? null;

  async function choose(next: string | null) {
    setOpen(false);
    setShown(next);
    await patch({ list_id: next }, { success: next ? `Filed under ${nameOf(next)}` : "Removed from its list" });
  }

  const label = nameOf(shown);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label ? `List: ${label}. Change it.` : "File this under a list"}
        className={VALUE_BUTTON}>
        {label ?? <span className="text-muted-foreground">No list</span>}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56 p-1">
        <form>
          <button type="submit" formAction={() => choose(null)} className={cn(MENU_ROW, "text-muted-foreground")}>
            No list
            {shown === null ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
          </button>

          {lists.map((list) => (
            <button
              key={list.id}
              type="submit"
              formAction={() => choose(list.id)}
              className={cn(MENU_ROW, shown === list.id && "font-semibold")}>
              <span className="min-w-0 flex-1 truncate">{list.name}</span>
              {shown === list.id ? <Check className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
            </button>
          ))}
        </form>
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
  label,
  className,
}: {
  parentId: string;
  /** Empty is fine — the composer falls back to "Myself", which is most subtasks. */
  assignable?: Assignable[];
  /**
   * P7-56 — a LABELLED button instead of the bare glyph, for a card header.
   *
   * The icon-only form is right in `TaskRowActions`, where it is one of four
   * marks in a hover strip on a dense row and a word per control would be a
   * paragraph per task. It was wrong in the Subtasks card header, because the
   * card directly below it puts "Upload" in the identical slot with a word on
   * it — the same affordance, in the same place, labelled in one case and not
   * the other, which left the `+` reading as decoration.
   */
  label?: string;
  /**
   * P7-56 — overrides the trigger's styling entirely. The task detail surface
   * passes its `ACTION_LINK`, so adding a subtask reads as one entry in that
   * page's list of actions rather than as a button competing with the status
   * controls above it.
   */
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Add a subtask"
        title="Add a subtask"
        className={cn(className ?? (label ? buttonVariants({ variant: "outline", size: "sm" }) : ICON_BUTTON))}>
        <Plus className={label && !className ? undefined : "size-3.5"} aria-hidden />
        {label}
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
    <span className="inline-flex items-center gap-1.5" title={`${done} of ${total} subtasks done`}>
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

/**
 * A PROPERTY VALUE THAT IS ALSO ITS OWN EDITOR.
 *
 * P7-56 — the shape the task detail's property block is built from, and the
 * reason that block can be compact at all. A boxed `Select` or `Input` per
 * property costs 40px of control plus a label above it; a value that opens a
 * popover when you click it costs one line, and reads as a fact rather than as
 * a form somebody left half-filled. It is what the team is already used to.
 *
 * The affordance is the hover fill and the focus ring — not a border, which
 * would make it a box again.
 */
const VALUE_BUTTON = cn(
  "-mx-1 min-w-0 truncate rounded-sm px-1 py-0.5 text-left",
  "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

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

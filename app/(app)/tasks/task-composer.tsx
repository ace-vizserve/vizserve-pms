"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, CircleUser, CornerDownLeft, Flag, Hourglass, Plus, X } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { toDateString } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TableCell, TableRow } from "@/components/ui/table";
import { TaskPriorityBadge } from "@/components/status-badge";
import { formatDate, parseDateOnly } from "@/lib/dates";
import {
  INITIAL_TASK_STATUS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/schemas/tasks";
import { formatCellDuration, parseCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { quickAddTask } from "./actions";

/**
 * K3 — INLINE CREATION, as a whole row rather than a title box.
 *
 * The first cut of this was one input: type a name, press Enter, then go back and
 * edit the row four times to say who it was for, when it starts, when it is due
 * and how long it should take. That is four round trips for something somebody
 * already knew when they typed the name, and it is why the reference this came
 * from makes every column fillable at the moment of creation.
 *
 * ONE COMPONENT, TWO SHAPES, and they are the same form:
 *
 *   `row`   a `<tr>` whose cells line up under the list's own columns
 *   `card`  a board card, the fields stacked because a column is 18rem wide
 *
 * Two shapes rather than two components, because the moment they are two
 * components is the moment the board learns a field the list does not have.
 *
 * A SUBTASK IS JUST ANOTHER TASK, NESTED — so the `+` on a row opens THIS, with
 * `parentId` set. There is no separate subtask form and no separate action;
 * P7-09's parent is one more field on the same create.
 *
 * The fast path is untouched: type a name, press Enter, done. Everything else is
 * optional and collapsed behind a control that says what it would set.
 */

export type Assignable = { id: string; full_name: string };

type Draft = {
  title: string;
  assigneeId: string | null;
  priority: TaskPriority | null;
  startDate: string;
  dueDate: string;
  estimateMinutes: number | null;
};

const EMPTY: Draft = {
  title: "",
  assigneeId: null,
  priority: null,
  startDate: "",
  dueDate: "",
  estimateMinutes: null,
};

function useComposer({
  status,
  parentId,
  onDone,
}: {
  status: TaskStatus;
  parentId: string | null;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    const title = draft.title.trim();
    if (!title) return;

    startTransition(async () => {
      const result = await quickAddTask({
        title,
        status,
        assignee_id: draft.assigneeId,
        priority: draft.priority,
        start_date: draft.startDate,
        due_date: draft.dueDate,
        estimate_minutes: draft.estimateMinutes,
        parent_task_id: parentId,
      });

      if (!result.ok) {
        // The draft is KEPT on failure. Everything typed into six fields is
        // worth more than a clean slate, and the toast explains what to change.
        toast.error(result.error);
        return;
      }

      // Cleared only on success, and the composer stays open: adding tasks is
      // something people do in runs of five.
      setDraft(EMPTY);
      onDone?.();
      router.refresh();
    });
  }

  return { draft, set, submit, pending };
}

/** Enter saves, Escape abandons — in every field, not only the title. */
function keys(submit: () => void, cancel: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };
}

// ---------------------------------------------------------------------------
// The list row
// ---------------------------------------------------------------------------

/**
 * A `<tr>` that lines up under the list's columns.
 *
 * It is rendered inside the same `<table>` as the rows above it — not as a div
 * underneath — because that is the only way the cells stay in the columns as the
 * table resizes. `DataTable`'s `appendRow` exists for exactly this.
 */
export function ComposerRow({
  status,
  parentId = null,
  assignable,
  onCancel,
}: {
  status: TaskStatus;
  parentId?: string | null;
  assignable: Assignable[];
  onCancel: () => void;
}) {
  const { draft, set, submit, pending } = useComposer({ status, parentId, onDone: undefined });
  const onKeyDown = keys(submit, onCancel);

  return (
    <TableRow className="bg-accent/20 hover:bg-accent/20">
      {/*
        The name, under the Task heading — and only the name. The priority
        picker used to sit in here beside it, which is why it appeared under
        "Task" while the Priority column showed nothing.

        ⚠️ THE INPUT NEEDS A FLOOR OF ITS OWN — see `min-w-48` below.

        A table cell is shrink-to-fit, and `Input` is `w-full min-w-0`: a
        percentage width resolving against a content-sized parent, with the
        floor explicitly removed. A row of real tasks is fine, because a title
        is text and text has a width. An EMPTY composer has no content at all,
        so the cell collapsed to the priority chip beside it and the field
        became a 24-pixel square you could not read what you were typing in.

        The floor goes on the INPUT rather than this cell. A width here would
        size the whole COLUMN — a table sizes a column across every row — so the
        Task column would jump wider the moment somebody clicked "add task" and
        snap back when they cancelled.
      */}
      {/* select — no checkbox on a row that does not exist yet. */}
      <TableCell className="w-8 pr-0" />

      <TableCell className="max-w-sm whitespace-normal">
        <Input
          autoFocus
          value={draft.title}
          disabled={pending}
          placeholder={parentId ? "Subtask name" : "Task name"}
          aria-label={
            parentId ? "Subtask name" : `Task name, added to ${TASK_STATUS_LABELS[status]}`
          }
          onChange={(event) => set("title", event.target.value)}
          onKeyDown={onKeyDown}
          // `min-w-48` overrides the primitive's `min-w-0` — cn is
          // tailwind-merge, so the later class wins on the same property.
          // Without it the input has no width of its own to insist on.
          className="h-8 min-w-48 w-full"
        />

        {/* Below `2xl` the cell holding Save is hidden with its column, so the
            commit would go with it. Same buttons, inside the one cell that is
            never hidden. The breakpoint must track the Save cell's own — they
            are the two halves of one control. */}
        <div className="mt-2 2xl:hidden">
          <Actions
            submit={submit}
            cancel={onCancel}
            pending={pending}
            disabled={!draft.title.trim()}
          />
        </div>
      </TableCell>

      {/* progress — a task with no subtasks has none, and it cannot have any yet. */}
      <TableCell className="hidden lg:table-cell text-2xs text-foreground-faint">—</TableCell>

      <TableCell className="hidden md:table-cell text-muted-foreground">
        <AssigneeField
          value={draft.assigneeId}
          people={assignable}
          disabled={pending}
          onChange={(next) => set("assigneeId", next)}
        />
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <PriorityField
          value={draft.priority}
          disabled={pending}
          onChange={(next) => set("priority", next)}
        />
      </TableCell>

      <TableCell className="hidden xl:table-cell whitespace-nowrap">
        <DateField
          value={draft.startDate}
          label="Start"
          disabled={pending}
          onChange={(next) => set("startDate", next)}
          onKeyDown={onKeyDown}
        />
      </TableCell>

      <TableCell className="hidden sm:table-cell whitespace-nowrap">
        <DateField
          value={draft.dueDate}
          label="Due"
          disabled={pending}
          onChange={(next) => set("dueDate", next)}
          onKeyDown={onKeyDown}
        />
      </TableCell>

      {/* closed — it is being created, so there is nothing to say here ever. */}
      <TableCell className="hidden 2xl:table-cell whitespace-nowrap text-2xs text-foreground-faint">
        —
      </TableCell>

      <TableCell className="hidden xl:table-cell whitespace-nowrap text-right">
        <EstimateInlineField
          value={draft.estimateMinutes}
          disabled={pending}
          onChange={(next) => set("estimateMinutes", next)}
        />
      </TableCell>

      {/* tracked — nobody can have logged time against a task that is not saved. */}
      <TableCell className="hidden xl:table-cell whitespace-nowrap text-right text-2xs text-foreground-faint">
        —
      </TableCell>

      {/* Save / Cancel, where the latest comment sits — the end of the row is
          where the eye finishes, which is where the commit belongs.

          ⚠️ ONE CELL PER COLUMN, IN THE COLUMN'S OWN ORDER AND WITH ITS OWN
          RESPONSIVE CLASS. This row had SEVEN cells against the table's ELEVEN,
          and the note here still claimed they matched — it was written when they
          did, and `select`, `progress`, `closed`, `tracked` and `comment` were
          added to the table afterwards without it. Every control had slid left
          of its heading: the priority picker sat under Task, the assignee under
          Progress, the start date under Priority.

          A cell must also carry the SAME `hidden … :table-cell` breakpoint as
          its column, or the two disagree about how many cells exist at a given
          width and the row shifts again — which is the same bug arriving by a
          different route. */}
      <TableCell className="hidden 2xl:table-cell">
        <Actions submit={submit} cancel={onCancel} pending={pending} disabled={!draft.title.trim()} />
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// The board card
// ---------------------------------------------------------------------------

/** The same form, stacked, sized for a column rather than a table. */
export function ComposerCard({
  status,
  parentId = null,
  assignable,
  onCancel,
}: {
  status: TaskStatus;
  parentId?: string | null;
  assignable: Assignable[];
  onCancel: () => void;
}) {
  const { draft, set, submit, pending } = useComposer({ status, parentId });
  const onKeyDown = keys(submit, onCancel);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-card grade-surface p-2.5 shadow-raised-lg">
      <Input
        autoFocus
        value={draft.title}
        disabled={pending}
        placeholder={parentId ? "Subtask name" : "Task name"}
        aria-label={
          parentId ? "Subtask name" : `Task name, added to ${TASK_STATUS_LABELS[status]}`
        }
        onChange={(event) => set("title", event.target.value)}
        onKeyDown={onKeyDown}
        className="h-8"
      />

      {/* The optional half. Each control names what it would SET when empty and
          shows the value when filled, so the card does not need labels beside
          six controls in an 18rem column. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <AssigneeField
          value={draft.assigneeId}
          people={assignable}
          disabled={pending}
          onChange={(next) => set("assigneeId", next)}
        />
        <DateField
          value={draft.startDate}
          label="Start"
          disabled={pending}
          onChange={(next) => set("startDate", next)}
          onKeyDown={onKeyDown}
        />
        <DateField
          value={draft.dueDate}
          label="Due"
          disabled={pending}
          onChange={(next) => set("dueDate", next)}
          onKeyDown={onKeyDown}
        />
        <PriorityField
          value={draft.priority}
          disabled={pending}
          onChange={(next) => set("priority", next)}
        />
        <EstimateInlineField
          value={draft.estimateMinutes}
          disabled={pending}
          onChange={(next) => set("estimateMinutes", next)}
        />
      </div>

      <div className="flex items-center gap-2">
        <Actions submit={submit} cancel={onCancel} pending={pending} disabled={!draft.title.trim()} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The trigger, and the fields
// ---------------------------------------------------------------------------

/**
 * "+ Add" — the closed state of the composer.
 *
 * Separate from the composer itself so the open form can replace it in the flow
 * rather than sitting under it, which is what makes the row appear where the task
 * will appear.
 */
export function ComposerTrigger({
  onOpen,
  label = "Add a task",
  shape = "row",
}: {
  onOpen: () => void;
  label?: string;
  shape?: "row" | "column";
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground",
        "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        shape === "column" ? "shrink-0 rounded-sm px-2 py-1.5" : "border-t px-3.5 py-2",
      )}
    >
      <Plus className="size-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

function Actions({
  submit,
  cancel,
  pending,
  disabled,
}: {
  submit: () => void;
  cancel: () => void;
  pending: boolean;
  disabled: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Button size="sm" onClick={submit} loading={pending} disabled={disabled}>
        Save
        <CornerDownLeft className="size-3" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" onClick={cancel} disabled={pending}>
        Cancel
      </Button>
    </span>
  );
}

/** The shared look of an unset field: a glyph and the word for what it sets. */
const CHIP = cn(
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-2xs",
  "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

function AssigneeField({
  value,
  people,
  disabled,
  onChange,
}: {
  value: string | null;
  people: Assignable[];
  disabled?: boolean;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = people.find((person) => person.id === value);

  /*
   * "Myself" is the default and is NOT a row in the list.
   *
   * Picking yourself and picking a colleague produce two different kinds of task
   * — `create_personal_task` sets `is_personal = true` and lets you close it
   * yourself — so "me" has to be distinguishable from "a person who happens to
   * be me". Null is that distinction.
   */
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(CHIP, value ? "border-accent-border bg-accent" : "border-dashed")}
        aria-label={chosen ? `Assigned to ${chosen.full_name}. Change it.` : "Assign to somebody"}
      >
        <CircleUser className="size-3.5 shrink-0" aria-hidden />
        <span className="max-w-24 truncate">{chosen ? chosen.full_name : "Myself"}</span>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56 p-1">
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
          className={cn(MENU_ROW, value === null && "font-semibold")}
        >
          Myself
          <span className="ml-auto text-2xs text-muted-foreground">personal</span>
        </button>

        {people.length === 0 ? (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">
            Nobody else in your department to assign to.
          </p>
        ) : (
          <div className="max-h-56 overflow-y-auto">
            {people.map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => {
                  onChange(person.id);
                  setOpen(false);
                }}
                className={cn(MENU_ROW, value === person.id && "font-semibold")}
              >
                <span className="truncate">{person.full_name}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DateField({
  value,
  label,
  disabled,
  onChange,
  onKeyDown,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(CHIP, value ? "border-accent-border bg-accent" : "border-dashed")}
        aria-label={value ? `${label} ${formatDate(value)}. Change it.` : `Set a ${label.toLowerCase()} date`}
      >
        <CalendarPlus className="size-3.5 shrink-0" aria-hidden />
        <span className="tabular-nums">{value ? formatDate(value) : label}</span>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto p-2">
        {/* `onKeyDown` rides the wrapper: react-day-picker owns its own grid
            navigation and exposes no `onKeyDown`, but the caller's handler (the
            composer's "keep typing to the next field" shortcut) still has to
            see the event. */}
        <div className="flex items-center gap-1.5" onKeyDown={onKeyDown}>
          {/* The Calendar directly, not `DatePicker` — this is already inside a
              Popover, and nesting one in another traps focus in the wrong layer
              and closes both on a single Escape. */}
          <Calendar
            mode="single"
            autoFocus
            aria-label={label}
            disabled={disabled}
            selected={value ? (parseDateOnly(value) ?? undefined) : undefined}
            defaultMonth={value ? (parseDateOnly(value) ?? undefined) : undefined}
            onSelect={(date) => {
              if (!date) return;
              onChange(toDateString(date));
              setOpen(false);
            }}
          />
          {value ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Clear the ${label.toLowerCase()} date`}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PriorityField({
  value,
  disabled,
  onChange,
}: {
  value: TaskPriority | null;
  disabled?: boolean;
  onChange: (next: TaskPriority | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={cn(CHIP, value ? "border-transparent p-0" : "border-dashed")}
        aria-label={value ? `Priority ${TASK_PRIORITY_LABELS[value]}. Change it.` : "Set a priority"}
      >
        {value ? (
          <TaskPriorityBadge priority={value} className="h-7" />
        ) : (
          <>
            <Flag className="size-3.5 shrink-0" aria-hidden />
            Priority
          </>
        )}
      </PopoverTrigger>

      <PopoverContent align="start" className="w-40 p-1">
        {/* Highest first — `TASK_PRIORITIES` is declared low→high because
            Postgres compares enums by declaration order. */}
        {[...TASK_PRIORITIES].reverse().map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onChange(option);
              setOpen(false);
            }}
            className={cn(MENU_ROW, value === option && "font-semibold")}
          >
            <Flag className="size-3.5 shrink-0" aria-hidden />
            {TASK_PRIORITY_LABELS[option]}
          </button>
        ))}
        {value !== null ? (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(MENU_ROW, "text-muted-foreground")}
          >
            Clear
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function EstimateInlineField({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled?: boolean;
  onChange: (next: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = raw.trim();

    if (!trimmed) {
      setError(null);
      onChange(null);
      setOpen(false);
      return;
    }

    // The timesheet's parser, so `2h` means the same thing here as in a cell.
    const minutes = parseCellDuration(trimmed);

    if (minutes === null || minutes === 0) {
      setError("Try 2h, 90m or 1.5.");
      return;
    }

    setError(null);
    onChange(minutes);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRaw(value === null ? "" : formatCellDuration(value));
          setError(null);
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        className={cn(CHIP, value !== null ? "border-accent-border bg-accent" : "border-dashed")}
        aria-label={value === null ? "Set an estimate" : `Estimate ${formatCellDuration(value)}. Change it.`}
      >
        <Hourglass className="size-3.5 shrink-0" aria-hidden />
        <span className="tabular-nums">
          {value === null ? "Estimate" : formatCellDuration(value)}
        </span>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-52 p-2">
        <div className="space-y-1.5">
          <Label htmlFor="composer-estimate" className="text-2xs text-muted-foreground">
            Estimate
          </Label>
          <Input
            id="composer-estimate"
            autoFocus
            value={raw}
            placeholder="2h 30m"
            aria-invalid={error ? true : undefined}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              // Enter commits the FIELD, not the form: a half-typed estimate must
              // not create the task.
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}
            onBlur={commit}
          />
          <p className={cn("text-2xs", error ? "text-destructive" : "text-muted-foreground")}>
            {error ?? "A plain number is hours."}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const MENU_ROW = cn(
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
  "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
);

export { INITIAL_TASK_STATUS };

"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Loader2, X } from "lucide-react";

import { bulkEditTasks, bulkTransitionTasks, selectionTargets } from "./actions";

import { TaskPriorityBadge, TaskStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { formatDate } from "@/lib/dates";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

/**
 * P7-70 — change the same few things on a whole selection.
 *
 * ⚠️ STATUS IS APPLIED SEPARATELY AND REPORTED SEPARATELY, because the database
 * treats it differently. Assignee, dates and priority are ordinary columns and
 * go in ONE update that RLS filters. `status` is outside the UPDATE grant
 * entirely: only `vizserve_pms_transition_task` moves a task, one at a time, and
 * it refuses illegal moves, the QA gate and a missing resolution.
 *
 * So moving eight tasks to FOR_QA legitimately produces "five moved, three need
 * a resolution first". That is not an error and not a success — it is the
 * answer, and this dialog says it rather than picking whichever is cheerier.
 *
 * ⚠️ AND A FIELD LEFT ALONE IS NOT A FIELD CLEARED. Nothing is sent but the keys
 * somebody touched. The alternative wipes three columns off forty rows to change
 * a fourth — which is the kind of thing nobody notices until a week later.
 *
 * THE SHAPE IS A PROPERTY LIST, not a form. Every row is "label · control ·
 * revert", the same arrangement the task detail uses for the same job, because
 * this is the same job done to more than one thing at once. The summary at the
 * foot is what makes it safe: a bulk edit is the one place where knowing
 * precisely what is about to happen matters more than the controls looking tidy.
 */

type Touched = {
  status?: TaskStatus;
  assignee_id?: string | null;
  due_date?: string | null;
  start_date?: string | null;
  priority?: TaskPriority | null;
};

/** A labelled row, with the revert that makes "leave as is" recoverable. */
function Field({
  label,
  htmlFor,
  set,
  onRevert,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** Has somebody touched this one? Drives the revert and the accent. */
  set: boolean;
  onRevert: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <Label
        htmlFor={htmlFor}
        className={cn(
          "w-20 shrink-0 pt-1.5 text-xs",
          // The label carries the "this one is changing" signal as well as the
          // control does — §5.5, and it is what makes the list scannable.
          set ? "font-medium text-foreground" : "text-muted-foreground",
        )}>
        {label}
      </Label>

      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>

      {/*
        ⚠️ AN EXPLICIT WAY BACK TO "LEAVE AS IS". Without it the only way to
        un-pick a status is to click the same pill again, which nobody
        discovers, and there is no way at all to un-pick a date. `invisible`
        rather than absent so the rows do not jump as fields are touched.
      */}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Leave ${label.toLowerCase()} as it is`}
        onClick={onRevert}
        className={cn("size-7 shrink-0", !set && "pointer-events-none invisible")}>
        <X />
      </Button>
    </div>
  );
}

export function BulkEditDialog({
  open,
  onOpenChange,
  taskIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskIds: string[];
  onDone: () => void;
}) {
  const [touched, setTouched] = useState<Touched>({});
  const [people, setPeople] = useState<{ id: string; full_name: string }[] | null>(null);
  const [pending, start] = useTransition();

  /*
   * The assignable people are fetched when the dialog opens, for the same reason
   * the copy dialog fetches its lists: this bar sits outside the page's Suspense
   * boundary on purpose, so it asks rather than being handed them.
   */
  /*
   * ⚠️ THE RESET LIVES ON THE CLOSE, NOT ON THE OPEN, and that is the whole
   * difference between this and a lint error. Clearing the edits at the top of
   * the open effect is a synchronous setState inside an effect — React's rule
   * refuses it (cascading renders), and it is the same trap
   * `task-image-lightbox.tsx` documents from the other side: the state has to
   * be put back to neutral by the EVENT that ends the interaction.
   *
   * Every close comes through here — the submit at the end of `submit()`, the
   * dialog's own Escape, backdrop and X, and the Cancel button — so there is no
   * path that leaves last time's edits behind for the next opening.
   */
  const close = useCallback(
    (next: boolean) => {
      if (!next) {
        setTouched({});
        setPeople(null);
      }

      onOpenChange(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;

    let live = true;

    void selectionTargets(taskIds).then((result) => {
      if (!live) return;
      if (!result.ok) return;
      setPeople(result.data.people);
    });

    return () => {
      live = false;
    };
  }, [open, taskIds]);

  function patch<K extends keyof Touched>(key: K, value: Touched[K]) {
    setTouched((current) => ({ ...current, [key]: value }));
  }

  function revert(key: keyof Touched) {
    setTouched((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  const count = taskIds.length;
  const nameOf = (id: string) => people?.find((person) => person.id === id)?.full_name ?? "someone";

  /**
   * What Apply will actually do, in words.
   *
   * ⚠️ IT LISTS THE CHANGES, NOT THE FIELDS. "Due date" tells you nothing; "due
   * date → 20 Sep 2026" is the thing worth checking before it lands on forty
   * rows, and it is the only place "Nobody" and "no due date" read as the
   * deliberate choices they are rather than as empty controls.
   */
  const summary: string[] = [];
  if (touched.status) summary.push(`status → ${TASK_STATUS_LABELS[touched.status]}`);
  if (touched.assignee_id !== undefined) {
    summary.push(`assignee → ${touched.assignee_id ? nameOf(touched.assignee_id) : "nobody"}`);
  }
  if (touched.start_date !== undefined) {
    summary.push(`start → ${touched.start_date ? formatDate(touched.start_date) : "cleared"}`);
  }
  if (touched.due_date !== undefined) {
    summary.push(`due → ${touched.due_date ? formatDate(touched.due_date) : "cleared"}`);
  }
  if (touched.priority !== undefined) {
    summary.push(`priority → ${touched.priority ? TASK_PRIORITY_LABELS[touched.priority] : "none"}`);
  }

  function submit() {
    start(async () => {
      const { status, ...fields } = touched;

      // The columns first — one statement, applied or filtered out by RLS.
      // Status last, because it can partly fail and its report is the one worth
      // reading at the end.
      if (Object.keys(fields).length > 0) {
        const result = await bulkEditTasks(taskIds, fields);

        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        const { changed, refused } = result.data;
        if (changed > 0) toast.success(`${changed} ${changed === 1 ? "task" : "tasks"} updated`);
        if (refused > 0) toast.error(`${refused} were not yours to edit`);
      }

      if (status) {
        const result = await bulkTransitionTasks(taskIds, status);

        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        const { moved, refused, reasons } = result.data;
        if (moved > 0) toast.success(`${moved} moved to ${TASK_STATUS_LABELS[status]}`);

        /* The reasons, not a count — "3 need a resolution first" is actionable
           and "3 failed" is not. Two at most: a third line in a toast stack is
           read by nobody. */
        if (refused > 0) for (const reason of reasons.slice(0, 2)) toast.error(reason);
      }

      close(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Edit {count} {count === 1 ? "task" : "tasks"}
          </DialogTitle>
          <DialogDescription>
            Only what you change here is written. Everything else stays as it is on each task.
          </DialogDescription>
        </DialogHeader>

        {/* Hairlines between rows rather than five boxed fields — the same
            argument the task page's sections make: a boundary, not a container. */}
        <div className="divide-y divide-border">
          <Field label="Status" set={Boolean(touched.status)} onRevert={() => revert("status")}>
            <div className="flex flex-wrap gap-1.5">
              {TASK_STATUSES.map((status) => {
                const picked = touched.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => (picked ? revert("status") : patch("status", status))}
                    className={cn(
                      "rounded-sm transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      // Selection is a ring plus `aria-pressed`, never the pill's
                      // own colour — that already means the status itself.
                      picked && "ring-2 ring-ring ring-offset-1",
                      // The unpicked ones recede once a choice is made, so the
                      // choice is findable in a row of seven.
                      touched.status && !picked && "opacity-45",
                    )}>
                    <TaskStatusBadge status={status} />
                  </button>
                );
              })}
            </div>
            <p className="text-2xs text-muted-foreground">
              Each task moves on its own. One that cannot — a QA gate, a missing resolution — stays
              where it is and says why.
            </p>
          </Field>

          <Field
            label="Assignee"
            htmlFor="bulk-assignee"
            set={touched.assignee_id !== undefined}
            onRevert={() => revert("assignee_id")}>
            {people === null ? (
              <p className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Loading the department…
              </p>
            ) : (
              <Select
                /*
                 * ⚠️ THE CLOSED TRIGGER READS THIS MAP, not the item rows below
                 * it. Without it the trigger renders the raw VALUE — "keep",
                 * "none", or a bare UUID for a colleague — which is what
                 * `npm run check:select-items` exists to catch.
                 *
                 * Every value this can hold needs an entry, the two sentinels
                 * included: a map spread from `people` alone would name the
                 * person and leave "Leave as is" showing as `keep`.
                 *
                 * ⚠️ AND NO ANGLE BRACKETS IN THIS COMMENT. The guard finds the
                 * end of an opening tag by scanning for the first unbraced `.gt.`
                 * character, so a JSX tag written out here ends the tag early,
                 * hides the attribute below and reports the offence it fixes.
                 */
                items={{
                  keep: "Leave as is",
                  none: "Nobody",
                  ...Object.fromEntries(people.map((person) => [person.id, person.full_name])),
                }}
                value={touched.assignee_id === undefined ? "keep" : (touched.assignee_id ?? "none")}
                onValueChange={(next) =>
                  patch("assignee_id", next === "none" ? null : String(next))
                }>
                <SelectTrigger id="bulk-assignee">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">Leave as is</SelectItem>
                  <SelectItem value="none">Nobody</SelectItem>
                  {people.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field
            label="Dates"
            set={touched.start_date !== undefined || touched.due_date !== undefined}
            onRevert={() => {
              revert("start_date");
              revert("due_date");
            }}>
            {/* The app's own picker, not `<input type="date">`: one calendar,
                one keyboard behaviour, and `lib/dates.ts` doing the parsing. */}
            <div className="grid grid-cols-2 gap-2">
              <DatePicker
                value={touched.start_date ?? null}
                onChange={(next) => patch("start_date", next)}
                placeholder="Start"
              />
              <DatePicker
                value={touched.due_date ?? null}
                onChange={(next) => patch("due_date", next)}
                placeholder="Due"
              />
            </div>
          </Field>

          <Field
            label="Priority"
            set={touched.priority !== undefined}
            onRevert={() => revert("priority")}>
            <div className="flex flex-wrap items-center gap-1.5">
              {TASK_PRIORITIES.map((priority) => {
                const picked = touched.priority === priority;
                return (
                  <button
                    key={priority}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => (picked ? revert("priority") : patch("priority", priority))}
                    className={cn(
                      "rounded-sm transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      picked && "ring-2 ring-ring ring-offset-1",
                      touched.priority !== undefined && !picked && "opacity-45",
                    )}>
                    <TaskPriorityBadge priority={priority} />
                  </button>
                );
              })}

              {/* Clearing a priority is a real choice — null is "nobody ranked
                  this", which is not the same as NORMAL. */}
              <Button
                type="button"
                size="xs"
                variant={touched.priority === null ? "default" : "outline"}
                aria-pressed={touched.priority === null}
                onClick={() =>
                  touched.priority === null ? revert("priority") : patch("priority", null)
                }>
                None
              </Button>
            </div>
          </Field>
        </div>

        {/* The one thing that makes a bulk edit safe to press. */}
        <p
          aria-live="polite"
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            summary.length === 0
              ? "text-muted-foreground"
              : "border-accent-border bg-accent text-accent-foreground",
          )}>
          {summary.length === 0
            ? "Nothing picked yet."
            : `On ${count} ${count === 1 ? "task" : "tasks"}: ${summary.join(" · ")}`}
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={pending}>
            Cancel
          </Button>
          {/* Disabled is never the only explanation (§4.2) — the line above says
              what is missing. */}
          <Button onClick={submit} loading={pending} disabled={summary.length === 0}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

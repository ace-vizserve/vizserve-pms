"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { bulkEditTasks, bulkTransitionTasks, selectionTargets } from "./actions";

import { TaskStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { TASK_STATUSES, type TaskPriority, type TaskStatus } from "@/lib/schemas/tasks";
import { TASK_PRIORITIES } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

/**
 * P7-70 — one dialog, four fields, two very different writes behind them.
 *
 * ⚠️ STATUS IS APPLIED SEPARATELY AND REPORTED SEPARATELY, because the database
 * treats it differently. Assignee, dates and priority are ordinary columns and
 * go in one UPDATE that RLS filters. `status` is outside the UPDATE grant
 * entirely: only `vizserve_pms_transition_task` moves a task, one at a time, and
 * it refuses illegal moves, the QA gate and a missing resolution.
 *
 * So moving eight tasks to FOR_QA legitimately produces "five moved, three need
 * a resolution first". That is not an error and not a success — it is the
 * answer, and this dialog says it rather than picking whichever is cheerier.
 *
 * ⚠️ AND A FIELD LEFT ALONE IS NOT A FIELD CLEARED. Every control starts at
 * "leave as is" and only the ones touched are sent. The alternative wipes three
 * columns off forty rows to change a fourth.
 */

type Touched = {
  status?: TaskStatus;
  assignee_id?: string | null;
  due_date?: string | null;
  start_date?: string | null;
  priority?: TaskPriority | null;
};

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
   * The assignable people come from the same place the copy dialog's lists do,
   * and for the same reason: this bar sits outside the page's Suspense boundary
   * on purpose, so it fetches rather than being handed them.
   */
  useEffect(() => {
    if (!open) return;

    let live = true;
    setTouched({});
    setPeople(null);

    void selectionTargets(taskIds).then((result) => {
      if (!live) return;
      if (!result.ok) return;
      setPeople(result.data.people);
    });

    return () => {
      live = false;
    };
  }, [open, taskIds]);

  const count = taskIds.length;
  const nothingPicked = Object.keys(touched).length === 0;

  function submit() {
    start(async () => {
      const { status, ...fields } = touched;

      // The columns first: one statement, and it either applies or RLS filtered
      // the row out. Status after, because it can partly fail and its report is
      // the one worth reading last.
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
        if (moved > 0) toast.success(`${moved} moved to ${status.replaceAll("_", " ").toLowerCase()}`);

        /* The reasons, not a count — "3 need a resolution first" is actionable
           and "3 failed" is not. Capped at two: a third line in a toast stack is
           read by nobody. */
        if (refused > 0) {
          for (const reason of reasons.slice(0, 2)) toast.error(reason);
        }
      }

      onOpenChange(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Edit {count} {count === 1 ? "task" : "tasks"}
          </DialogTitle>
          <DialogDescription>
            Anything you leave alone stays as it is on each task.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <div className="flex flex-wrap gap-1.5">
              {TASK_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={touched.status === status}
                  onClick={() =>
                    setTouched((current) => {
                      const next = { ...current };
                      if (next.status === status) delete next.status;
                      else next.status = status;
                      return next;
                    })
                  }
                  className={cn(
                    "rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    // Selected is carried by the ring AND `aria-pressed`, never
                    // by the pill's own colour — that already means the status.
                    touched.status === status && "ring-2 ring-ring ring-offset-1",
                  )}>
                  <TaskStatusBadge status={status} />
                </button>
              ))}
            </div>
            <p className="text-2xs text-muted-foreground">
              Each task moves on its own. One that cannot — a QA gate, a missing resolution — is
              left where it is and says why.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bulk-assignee">Assignee</Label>
            {people === null ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Loading…
              </p>
            ) : (
              /* The primitive, never a bare `<select>` (§2): it carries the
                 token wiring, the seven states and the Base UI keyboard and
                 ARIA behaviour that a native control has none of. */
              <Select
                value={touched.assignee_id === undefined ? "keep" : (touched.assignee_id ?? "none")}
                onValueChange={(next) =>
                  setTouched((current) => {
                    const patch = { ...current };
                    if (next === "keep") delete patch.assignee_id;
                    else patch.assignee_id = next === "none" ? null : String(next);
                    return patch;
                  })
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
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-start">Start date</Label>
              <Input
                id="bulk-start"
                type="date"
                value={touched.start_date ?? ""}
                onChange={(event) =>
                  setTouched((current) => ({ ...current, start_date: event.target.value || null }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bulk-due">Due date</Label>
              <Input
                id="bulk-due"
                type="date"
                value={touched.due_date ?? ""}
                onChange={(event) =>
                  setTouched((current) => ({ ...current, due_date: event.target.value || null }))
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Priority</Label>
            <div className="flex flex-wrap gap-1.5">
              {TASK_PRIORITIES.map((priority) => (
                <Button
                  key={priority}
                  type="button"
                  variant={touched.priority === priority ? "default" : "outline"}
                  size="xs"
                  onClick={() =>
                    setTouched((current) => {
                      const next = { ...current };
                      if (next.priority === priority) delete next.priority;
                      else next.priority = priority;
                      return next;
                    })
                  }>
                  {priority.toLowerCase()}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {/* Disabled until something is actually going to change — and the
              description above says why, so it is never the only explanation. */}
          <Button onClick={submit} loading={pending} disabled={nothingPicked}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useOptimisticMove } from "./optimistic-move";
import { Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDuration } from "@/lib/dates";

import { invalidateTaskWrite } from "@/lib/query/invalidate";

import { deleteTask, taskDeleteImpact, type TaskDeleteImpact } from "./actions";

/**
 * P7-19 — deleting an internal task, with the damage named first.
 *
 * ⚠️ THE IMPACT IS FETCHED WHEN THE DIALOG OPENS, not when it submits. A task
 * cascades to nine tables, and two of those cascades are ones nobody expects:
 * `parent_task_id` takes every subtask beneath it, and the timesheet entries on
 * those subtasks go with them. Somebody deleting "Phase 2 Implementation" is
 * about to remove ten tasks and twenty hours of logged time, and finding that
 * out from a toast afterwards is finding out too late.
 *
 * So the confirm button stays disabled until the count comes back. A confirm
 * dialog that lets you press Delete before it knows what Delete does is a
 * dialog that is only pretending to ask.
 *
 * Client-backed work is refused by the database, not by this component. The
 * refusal arrives as `{ ok: false, reason }` and is rendered as-is — one
 * wording, in one place, rather than a sentence per screen.
 */
export function DeleteTaskDialog({
  taskId,
  title,
  onDeleted,
  render,
}: {
  taskId: string;
  title: string;
  /** Called after a successful delete — the board uses it to drop the card. */
  onDeleted?: () => void;
  /** A custom trigger. Defaults to a ghost trash button. */
  render?: (open: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<TaskDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * P12-06 — THE CACHE, AS WELL AS THE REFRESH. NOT INSTEAD OF IT.
   *
   * This dialog is shared: the detail header, every list row and every board
   * card can open it. `/tasks/[id]` reads `qk.task(id)` from the cache now, so a
   * delete has to invalidate; `/tasks` and `/tasks/board` still read their rows
   * from the cache too since P12-07, so P12-09 took the `router.refresh()` out:
   * one mechanism, not two. The AWAITED invalidate is what holds the optimistic
   * removal across the settle — see the note at the call site, and
   * `lib/query/invalidate.ts` for what `ded2244` cost.
   */
  const queryClient = useQueryClient();
  const [loadingImpact, startImpact] = useTransition();
  const [pending, startDelete] = useTransition();

  function show() {
    setImpact(null);
    setError(null);
    setOpen(true);

    startImpact(async () => {
      const result = await taskDeleteImpact(taskId);
      if (!result.ok) setError(result.error);
      else setImpact(result.data);
    });
  }

  /*
   * P11-05 — the row goes on confirm.
   *
   * Null on the task DETAIL page, where deleting navigates away and there is no
   * list to remove anything from. Optional by construction rather than by check.
   */
  const removeRow = useOptimisticMove();

  function confirm() {
    setError(null);

    // Closed first: the dialog is modal, and leaving it up over a row that has
    // already gone reads as the delete not having worked.
    setOpen(false);

    startDelete(async () => {
      removeRow?.({ kind: "remove", id: taskId });

      const result = await deleteTask(taskId);
      if (!result.ok) {
        // React brings the row back; the dialog reopens carrying the reason.
        setError(result.error);
        setOpen(true);
        return;
      }

      /*
       * ⚠️ P12-08 — THE TOAST GOES FIRST, BEFORE ANYTHING IS AWAITED. It reports
       * the WRITE, which has already happened; scheduled after the invalidation
       * it reported the refetch instead, and arrived up to a second late on a
       * screen that had already moved. See `lib/query/invalidate.ts`.
       */
      toast.success("Task deleted");

      /*
       * ⚠️ P12-09 — `router.refresh()` WAS HERE, AND THE AWAITED INVALIDATE
       * BELOW IS WHAT REPLACED IT. Read this before putting it back.
       *
       * The refresh existed to HOLD THE TRANSITION OPEN. `useOptimistic` drops
       * its value the instant the transition that set it ends, and Next resolves
       * an action's promise BEFORE the router commits the revalidated tree — so
       * without something pending, the value snapped back to the old one with
       * the success toast firing in the gap. That is `ded2244`, which reverted
       * this same removal across eighteen files in a day. The full account is
       * the long note in `app/(app)/tasks/inline.tsx`.
       *
       * What changed is not the argument, it is the data path. `/tasks`,
       * `/tasks/board` and `/tasks/[id]` all read from the cache now, so
       * `invalidateTaskWrite` refetches the very rows this control is rendered
       * over — and it is AWAITED, inside the same transition, which is exactly
       * the hold the refresh was providing. One mechanism instead of two, and
       * the route render that ran beside every click is gone.
       *
       * ⚠️ SO THE AWAIT IS NOT OPTIONAL AND MUST NOT BECOME A FIRE-AND-FORGET.
       * Removing it is `ded2244` again, through a different door.
       */
      /*
       * `qk.task(id)` is invalidated as well as the list views: a deleted task's
       * own detail page may still be mounted — this dialog is reachable FROM a
       * subtask row — and leaving a fresh copy of a deleted row in the cache is
       * how the back button resurrects it.
       */
      await invalidateTaskWrite(queryClient, taskId);
      onDeleted?.();
    });
  }

  const blocked = impact?.ok === false;
  const damage = impact?.ok ? impact : null;

  // The lines that make this a warning rather than a prompt. Only what is
  // actually there — a list padded with "0 comments" reads as boilerplate and
  // stops being read at all.
  const losses = damage
    ? [
        damage.subtasks > 0
          ? `${damage.subtasks} ${damage.subtasks === 1 ? "subtask" : "subtasks"}`
          : null,
        damage.tracked_minutes > 0 ? `${formatDuration(damage.tracked_minutes)} of logged time` : null,
        damage.comments > 0
          ? `${damage.comments} ${damage.comments === 1 ? "comment" : "comments"}`
          : null,
        damage.attachments > 0
          ? `${damage.attachments} ${damage.attachments === 1 ? "file" : "files"}`
          : null,
      ].filter(Boolean)
    : [];

  return (
    <>
      {render ? (
        render(show)
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${title}`}
          onClick={show}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
            <DialogDescription className="break-words">{title}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1 text-sm">
            {loadingImpact ? (
              <p className="text-muted-foreground">Checking what this would remove…</p>
            ) : blocked ? (
              <p
                role="alert"
                className="rounded-sm border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning"
              >
                {(impact as { reason: string }).reason}
              </p>
            ) : damage ? (
              <>
                {losses.length > 0 ? (
                  <div className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2">
                    <p className="text-xs font-medium text-destructive">This also deletes:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-destructive">
                      {losses.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    Nothing is logged against it, so only the task itself goes.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">This cannot be undone.</p>
              </>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <form id="delete-task" action={confirm} className="hidden" />
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="submit"
              form="delete-task"
              loading={pending}
              // Disabled until the impact is known: a confirm that can be pressed
              // before the dialog knows what it destroys is only pretending to ask.
              disabled={!damage || loadingImpact}
            >
              {damage && losses.length > 0 ? "Delete anyway" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

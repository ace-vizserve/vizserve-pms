"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { toneButtonVariant } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { isRichTextEmpty } from "@/lib/rich-text";
import { transitionTone, type TaskStatus, type Transition } from "@/lib/schemas/tasks";

import { invalidateTaskWrite } from "@/lib/query/invalidate";
import { fromAction } from "@/lib/query/mutate";
import { beginTaskWrite, cancelTaskRefetches, patchTaskRow, rollbackTaskWrite } from "@/lib/query/task-cache";

import { transitionTask } from "./actions";

/** The Server Action, as a promise TanStack can drive `onError` off. */
const moveTask = fromAction(transitionTask);

/**
 * P7-61 — MOVING A TASK, ONCE, FOR EVERY CONTROL THAT MOVES ONE.
 *
 * There are two now: the dropdown (`status-select.tsx`, which internal work
 * still needs because free movement offers seven destinations) and the row of
 * buttons client work gets instead (`[id]/task-actions.tsx`). Both have to
 * await the resolution autosave, both have to collect a note on the moves that
 * demand one, and both have to surface the server's refusal rather than a toast
 * that disappears. That is enough shared behaviour that a second copy would
 * drift on the first change — and the part most likely to drift is the note,
 * which is the most consequential thing anybody types on this page.
 */

export type TaskTransitionState = ReturnType<typeof useTaskTransition>;

export function useTaskTransition({
  taskId,
  status,
  onMoved,
  beforeMove,
}: {
  taskId: string;
  /**
   * The status on screen.
   *
   * ⚠️ IT IS ALREADY OPTIMISTIC AND THIS HOOK NO LONGER SHADOWS IT. It comes
   * from the cached row, and `onMutate` writes the new status into that row
   * before the request leaves — so the caller's prop moves on the click. This
   * used to be "the status the SERVER last confirmed", with a `useOptimistic`
   * over it; see the note in `commit` for why that had to go.
   */
  status: TaskStatus;
  /** The detail page has local state to reset; a list row only needs the refresh. */
  onMoved?: () => void;
  /**
   * Run and AWAITED before the move reaches the server.
   *
   * One caller, one reason: the task detail commits its debounced resolution
   * here, because that field is the precondition of a move these controls
   * offer. Clicking blurs the textarea and schedules a save, but that is a
   * round trip racing this one — and losing it produces the worst failure on
   * the page: "Send for QA" refused for an empty column, with the text plainly
   * on screen.
   */
  beforeMove?: () => Promise<void>;
}) {
  /** Non-null while a comment-requiring move waits for its comment. */
  const [prompt, setPrompt] = useState<Transition | null>(null);
  /**
   * WHICH move is in flight, not merely that one is.
   *
   * Client work draws its moves as a ROW of buttons, and `pending` alone would
   * put a spinner on every one of them — so pressing "Pass QA" would also
   * animate "Send back to PIC", which reads as both happening at once.
   */
  const [active, setActive] = useState<Transition | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  /*
   * ------------------------------------------------------------------------
   * P12-10 — THE CHIP MOVES WHEN YOU PICK, AND THE CONTROL COMES BACK WHEN THE
   * WRITE RETURNS. Those used to be two different moments about a second apart.
   *
   * This control is on the detail header, every list row and every board card,
   * which makes it the most-pressed thing in the product. The paint was already
   * instant (P11-05, `useOptimistic`) — but `useOptimistic` DROPS ITS VALUE WHEN
   * ITS TRANSITION ENDS, so the transition had to be held open across an awaited
   * `invalidateTaskWrite`, and that awaits `qk.tasks()`: the whole list and the
   * whole board, seven queries in two waves, before the dropdown was usable
   * again. Half-instant, which is what Ace reported as lag.
   *
   * ⚠️ THE HOLD IS NOT REMOVED, IT IS RELOCATED. `onMutate` writes the new
   * status into the CACHED ROW — the same row this control renders from — so the
   * value survives on its own and there is nothing left to hold. `a64b06c`
   * removed the hold with nothing in its place and `ded2244` reverted it the
   * same day across eighteen files; this is not that. The row does not revert,
   * because nothing about it is scoped to a transition.
   *
   * ⚠️ THE ROW ALSO CHANGES GROUP, WITH NO SEPARATE MECHANISM. On `/tasks` the
   * rows are bucketed under status headings, and a repainted chip in the wrong
   * group is half an update. `TaskStatusGroups` buckets from the cached rows, so
   * patching `status` moves the row AND the chip AND the heading count — which
   * is what the `OptimisticMoveContext` existed to do and no longer has to.
   *
   * ⚠️ AND A REFUSED MOVE NEEDS REAL ROLLBACK CODE NOW. React used to put the
   * chip back for free. `onError` restores the snapshot; without it the row
   * would sit in a group the database refused to move it to.
   * ------------------------------------------------------------------------
   */
  const move = useMutation({
    mutationFn: async (vars: { transition: Transition; comment?: string }) =>
      moveTask(taskId, {
        to_status: vars.transition.to,
        ...(vars.comment ? { comment: vars.comment } : {}),
      }),

    onMutate: async (vars) => {
      /*
       * ⚠️ THE PAINT COMES FIRST. NOTHING IS AWAITED IN FRONT OF IT.
       *
       * This block used to open with `await beforeMove?.()`, so on the task
       * detail the chip waited on the resolution autosave — a whole round trip
       * — before the cache was touched. That is the "why is state update taking
       * so long? not instant?" Ace reported. An optimistic paint that waits on
       * the network is not an optimistic paint.
       */
      const snapshot = beginTaskWrite(queryClient);
      patchTaskRow(queryClient, taskId, { status: vars.transition.to });

      // Fired, not awaited, and AFTER the patch -- see `cancelTaskRefetches`.
      cancelTaskRefetches(queryClient);

      /*
       * ⚠️ STILL AWAITED, AND STILL BEFORE THE WRITE REACHES THE SERVER — only
       * after the paint. The reason is unchanged: clicking blurs the textarea
       * and SCHEDULES a save, which is a round trip racing this one, and losing
       * it produces the worst failure on the page — "Send for QA" refused for an
       * empty column with the text plainly on screen. `mutationFn` does not run
       * until this resolves, so the precondition still holds.
       *
       * Its own invalidation can no longer land on top of the new status:
       * `cancelTaskRefetches` above has already been fired, and
       * `invalidateDerived` does not touch the row.
       */
      await beforeMove?.();

      return snapshot;
    },

    onError: (error, _vars, snapshot) => {
      if (snapshot) rollbackTaskWrite(queryClient, snapshot);
      setError(error.message || "That did not go through.");
    },

    onSuccess: (_data, vars) => {
      // Reports the WRITE, which has already happened. Nothing is awaited before
      // it, so it is not reporting a refetch.
      toast.success(vars.transition.label);
      setPrompt(null);
      setError(null);
      onMoved?.();
    },

    /*
     * ⚠️ FIRED, NOT AWAITED. The whole task, not one part: a move writes a
     * `task_status_history` row, may write a `client_decisions` row, and changes
     * the counts in the rail. `qk.task(id)` prefix-matches every panel of this
     * task. None of it is on screen yet, and none of it is what the person is
     * waiting for.
     */
    /*
     * ⚠️ TANSTACK'S DOCUMENTED SHAPE: invalidate what the write affected, on
     * BOTH paths, so the optimistic guess is always reconciled against the
     * server. Fired, never awaited -- awaiting is what used to hold the
     * interaction open, and with `onMutate` there is no transition whose end
     * could drop a value.
     *
     * It was briefly narrowed to derived data only, on the theory that
     * refetching a row we had just patched was what felt slow. It was not: a
     * production build is fast, and the lag was `npm run dev`. Narrow
     * invalidation trades a real guarantee -- the screen reconciles with the
     * database after every write -- for a saving that did not exist.
     */
    onSettled: () => {
      setActive(null);
      void invalidateTaskWrite(queryClient, taskId);
    },
  });

  const pending = move.isPending;

  /**
   * The one entry point, whether it came from a form submit or the comment
   * dialog.
   */
  function commit(transition: Transition, comment?: string) {
    setError(null);
    setActive(transition);
    move.mutate({ transition, comment });
  }

  /**
   * A move needing a note asks for it first rather than moving and hoping
   * somebody adds one afterwards. Everything else goes straight through — a
   * confirmation step on a reversible move only teaches people to click past
   * dialogs.
   */
  function choose(transition: Transition) {
    if (transition.requires === "comment") {
      setError(null);
      setPrompt(transition);
      return;
    }
    commit(transition);
  }

  function dismiss() {
    setPrompt(null);
    setError(null);
  }

  /** Is THIS the move currently in flight? */
  function isRunning(transition: Transition) {
    return pending && active?.from === transition.from && active?.to === transition.to;
  }

  /*
   * ⚠️ THE PROP, NOT A SHADOW OF IT. `shownStatus` was a `useOptimistic` over
   * `status`; the cached row carries the prediction now, so the two are the same
   * value and keeping both would be two things to disagree. The NAME is kept
   * because `status-select.tsx` reads it in four places and says in a comment
   * why it must not read a second source — which is still the right rule, now
   * satisfied by there only being one.
   */
  const shownStatus = status;

  return { pending, error, prompt, choose, commit, dismiss, isRunning, shownStatus } as const;
}

/**
 * THE NOTE, IN A DIALOG — and it used to be typed inside a 288px popover.
 *
 * "Send back to PIC" is the single most consequential thing anyone writes on a
 * task: it is immutable, it is in the audit trail, it is what the PIC reads at
 * the top of Activity, and it is the only record of WHY a piece of client work
 * bounced. It was asked for in a three-row textarea wedged under a dropdown's
 * own heading, which is the shape you use for a search box.
 *
 * A dialog is also the honest signal. Everything else these controls do happens
 * on the click; this one stops and asks, so it should look like stopping.
 *
 * ⚠️ RENDER IT AS A SIBLING OF THE TRIGGER, never inside a `Popover`. A dialog
 * nested in a popover dies with it the moment the popover dismisses — which it
 * does as soon as focus moves into the dialog.
 */
export function TransitionCommentDialog({ state }: { state: TaskTransitionState }) {
  const transition = state.prompt;
  if (!transition) return null;

  // Keyed on the destination, so a half-typed note cannot reappear next to a
  // DIFFERENT chosen move. Remounting is what clears it.
  return (
    <CommentDialog
      key={`${transition.from}-${transition.to}`}
      state={state}
      transition={transition}
    />
  );
}

function CommentDialog({
  state,
  transition,
}: {
  state: TaskTransitionState;
  transition: Transition;
}) {
  const [comment, setComment] = useState("");

  const returning = transition.to === "ONGOING";

  /* One string, two consumers: the visible <Label> and the editor's
     `aria-label`. Stated once so they cannot drift apart. */
  const label =
    transition.to === "WAITING_FOR_INFO"
      ? "What are you waiting for?"
      : returning
        ? "What needs changing?"
        : "Add a comment";
  const tone = transitionTone(transition);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) state.dismiss();
      }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{transition.label}</DialogTitle>
          {/*
            ⚠️ SAYS WHERE THIS ENDS UP, because without that people write it
            twice.

            A reviewer sending work back typed "the logo is the old one" into
            the Activity composer AND again here, because nothing said the two
            were connected. They are not the same record and only one of them is
            a MESSAGE: a comment is conversation — editable, deletable, attached
            to no status — while this is the REASON bound to the move,
            immutable, in the audit trail, and the thing the feed marks "needs
            changes". It already renders at the top of Activity, tagged and
            flagged. Saying so is the whole fix.
          */}
          <DialogDescription>
            {returning
              ? "The PIC sees this at the top of Activity, flagged as needing changes — no need to comment as well."
              : "Shown at the top of Activity, and counted toward how long this spent waiting."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          {/* No `htmlFor` — the editor's input is a contenteditable, which is
              not a labelable element. It carries the same words as its
              `aria-label`. */}
          <Label>{label}</Label>
          <RichTextEditor
            ariaLabel={label}
            value={comment}
            onChange={setComment}
            minHeight="min-h-32"
            placeholder={
              returning
                ? "e.g. The logo is the old one — please use the 2026 mark."
                : "e.g. Waiting on the client to confirm which of the two headlines."
            }
          />
          {state.error ? (
            <p role="alert" className="text-xs text-destructive">
              {state.error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={state.pending} onClick={() => state.dismiss()}>
            Cancel
          </Button>
          <Button
            variant={toneButtonVariant(tone)}
            loading={state.pending}
            // Never the sole explanation for why it is unavailable: the label
            // above says a note is the whole point of this dialog, so an empty
            // box already carries its own reason.
            disabled={isRichTextEmpty(comment)}
            onClick={() => state.commit(transition, comment)}>
            {transition.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

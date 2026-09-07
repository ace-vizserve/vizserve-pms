"use client";

import { useOptimistic, useState, useTransition } from "react";
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
import { useOptimisticMove } from "./task-status-groups";
import { transitionTone, type TaskStatus, type Transition } from "@/lib/schemas/tasks";

import { transitionTask } from "./actions";

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
   * The status the SERVER last confirmed. Only used as the base for the
   * optimistic value below — nothing here writes it.
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
  const [pending, startTransition] = useTransition();
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

  /*
   * P11-05 — THE CHIP MOVES WHEN YOU PICK, NOT WHEN THE SERVER ANSWERS.
   *
   * This control is on the detail header, every list row and every board card,
   * which makes it the most-pressed thing in the product. It used to freeze the
   * dropdown for a full round trip and only then repaint — so the one
   * interaction people do dozens of times a day was the one that felt slowest.
   *
   * ⚠️ AND THE OPTIMISM IS THE SMALLER HALF. Painting early hides latency; it
   * does not remove it, and a move that still takes two round trips is still
   * slow — it just looks better while it is. `router.refresh()` used to run
   * after the action and fetch the same route a second time. It is gone: the
   * Server Action calls `revalidatePath` itself, so the fresh RSC payload comes
   * back WITH the action's response, inside this transition. One trip, not two,
   * and the optimistic value holds until the real one arrives because both are
   * in the same transition.
   *
   * ⚠️ THAT MAKES `refresh()` IN `actions.ts` THE ONLY THING THAT REPAINTS.
   * A route missing from its list now goes stale instead of being quietly
   * rescued by the second fetch — `/tasks/board` was missing and has been
   * added.
   *
   * ⚠️ AND IT REVERTS ON FAILURE FOR FREE. A refused move needs no rollback
   * code: React drops the optimistic value, the chip returns to what the server
   * still says, and `error` below is what explains it. That is the half the
   * hand-rolled `usePatch` in `inline.tsx` has to write out by hand.
   */
  const [shownStatus, setShownStatus] = useOptimistic(status);

  /*
   * ⚠️ THE CHIP IS NOT THE ONLY THING THAT HAS TO MOVE. On `/tasks` the rows
   * are bucketed under status headings, so a repainted chip in the wrong group
   * is half an update — and half-instant is worse than not instant, because the
   * eye goes straight to the thing that did not move.
   *
   * Null on the detail page and the board, which render this control with no
   * groups around them. Optional by construction rather than by check.
   */
  const moveRow = useOptimisticMove();

  function commit(transition: Transition, comment?: string) {
    setError(null);
    setActive(transition);
    startTransition(async () => {
      // Inside the transition, before the await: this is the paint. Both of
      // them, so the chip and the row it sits in move together.
      setShownStatus(transition.to);
      moveRow?.({ id: taskId, status: transition.to });

      await beforeMove?.();

      const result = await transitionTask(taskId, {
        to_status: transition.to,
        ...(comment ? { comment } : {}),
      });

      setActive(null);

      if (!result.ok) {
        setError(result.error ?? "That did not go through.");
        return;
      }

      toast.success(transition.label);
      setPrompt(null);
      setError(null);
      onMoved?.();
    });
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

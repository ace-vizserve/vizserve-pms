"use client";

import { TaskStatusBadge, toneButtonVariant } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  availableTransitions,
  isTerminal,
  transitionIntent,
  transitionTone,
  type TaskStatus,
  type Transition,
} from "@/lib/schemas/tasks";

import { TransitionCommentDialog, useTaskTransition } from "../transition";

/**
 * P7-61 — CLIENT WORK GETS BUTTONS, NOT A DROPDOWN.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN P7-60 DELETED THE BUTTONS.
 *
 * P7-60 was right about the screen it was looking at and wrong to apply the
 * answer to both kinds of task. INTERNAL work moves freely (P7-13a): every
 * status is legal from every status, so the header held a dropdown of seven
 * destinations AND two promoted buttons drawn from the same seven — three
 * identical-looking controls whose differences were a rule about transition
 * scopes that nobody reading the screen can see. Deleting two of them was the
 * fix.
 *
 * CLIENT work is the opposite shape and always has been. `availableTransitions`
 * filters it to the approved flow, so the menu is ONE or TWO rows — and a
 * dropdown over two rows is furniture. Worse, it made the two moves look
 * identical: "Pass QA" and "Send back to PIC" were the same 13px grey text on
 * the same white row, under a banded heading, behind a click. The single most
 * consequential decision in the whole lifecycle was two indistinguishable lines
 * in a menu.
 *
 * So the rule is the count, not the taste: a fixed short flow shows its moves;
 * free movement hides them behind a picker. `task-header.tsx` chooses.
 * ------------------------------------------------------------------------
 *
 * ⚠️ COLOUR IS THE SECOND CARRIER, NEVER THE ONLY ONE. Each button wears the
 * tone of what it DOES — `transitionTone`, which is advance/return/hold and not
 * the tone of the status it lands on, because "Pass QA" lands on the `warning`
 * of FOR_CLIENT_APPROVAL and "Send back to PIC" lands on the `brand` of
 * ONGOING, which would paint approval as caution and rejection as progress. The
 * wording ("Pass QA" / "Send back to PIC") carries the meaning on its own; the
 * fill only makes it answerable from across the room, and the whole row still
 * reads correctly in greyscale (§5.5).
 *
 * Client work never offers two forward moves at once, so exactly one button is
 * the solid brand primary and the page keeps a single obvious action.
 */
export function TaskActions({
  taskId,
  status,
  viewer,
  task,
  resolutionMissing = false,
  onMoved,
  beforeMove,
}: {
  taskId: string;
  status: TaskStatus;
  viewer: { isAssignee: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean };
  task: { request_id: string | null; is_personal: boolean };
  /**
   * The SAVED resolution is empty. The database checks the saved value, so a
   * caller must not pass an unsaved draft here — the button would be live and
   * the server would then refuse it.
   */
  resolutionMissing?: boolean;
  onMoved?: () => void;
  beforeMove?: () => Promise<void>;
}) {
  const move = useTaskTransition({ taskId, onMoved, beforeMove });

  const transitions = availableTransitions(status, viewer, task);

  /*
   * Nothing to offer, so nothing to press. An inert button promises an
   * interaction and then refuses it; the chip and a sentence are honest, and
   * the two reasons are different facts so the sentence says which one it is.
   */
  if (transitions.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <TaskStatusBadge status={status} />
        <p className="text-xs text-muted-foreground">
          {isTerminal(status) ? "This task is finished." : "It is with somebody else."}
        </p>
      </div>
    );
  }

  // The forward move last, where a primary action sits in every dialog footer
  // in this app. On client work there is never more than one of them.
  const ordered = [...transitions].sort(
    (a, b) => rank(transitionIntent(a)) - rank(transitionIntent(b)),
  );

  const blocked = (transition: Transition) =>
    transition.requires === "resolution" && resolutionMissing;

  const anyBlocked = ordered.some(blocked);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* WHERE THE WORK IS, beside where it can go. The buttons say what
            happens next; only this says what is true now, and the track above
            the columns is too far from the controls to answer it here. */}
        <TaskStatusBadge status={status} />

        {ordered.map((transition) => (
          <Button
            key={`${transition.from}-${transition.to}`}
            variant={toneButtonVariant(transitionTone(transition))}
            // The spinner goes on the one that was pressed; the others simply
            // stop taking clicks until it settles.
            loading={move.isRunning(transition)}
            disabled={blocked(transition) || move.pending}
            onClick={() => move.choose(transition)}>
            {/* The transition's OWN wording — "Send for QA" says more than the
                status name it lands on. */}
            {transition.label}
          </Button>
        ))}
      </div>

      {/*
        ⚠️ THE GATE'S REASON, IN WORDS. A disabled control must never be the
        only explanation for why it is unavailable (§4.2), and the P3-07 gate is
        not a rule about who you are — it is a field somebody has to fill in, so
        it is answerable. The warning on the empty box itself is the other
        carrier; this one is here because the button is here.
      */}
      {anyBlocked ? (
        <p className="text-2xs text-muted-foreground">
          Fill in the resolution, under The work, first.
        </p>
      ) : null}

      {/* The server refused it. Never a toast: a toast for a refusal disappears
          before the person has finished reading why. */}
      {move.error && !move.prompt ? (
        <p role="alert" className="text-2xs text-destructive">
          {move.error}
        </p>
      ) : null}

      <TransitionCommentDialog state={move} />
    </div>
  );
}

function rank(intent: ReturnType<typeof transitionIntent>): number {
  return intent === "advance" ? 2 : intent === "hold" ? 1 : 0;
}

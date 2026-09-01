"use client";

import { ArrowRightLeft, Check, ChevronDown, Search } from "lucide-react";
import { useState } from "react";

import { TaskStatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUS_LABELS,
  availableTransitions,
  isTerminal,
  taskCategory,
  type TaskStatus,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { TransitionCommentDialog, useTaskTransition } from "./transition";

/**
 * K3 — THE status control. One component, used everywhere a task's status is
 * shown and movable: the detail page, the list row and the board card.
 *
 * Clicking the chip opens the list of statuses with the current one ticked;
 * picking one moves the task. That is the whole interaction, and it is what
 * P7-13a's free movement was for — somebody moving their own work between
 * stages should not have to reason about which moves are on offer. Before this
 * the detail page drew one BUTTON per legal move, which is fine at two and
 * unusable at seven: internal work now legally reaches every status except
 * `FOR_CLIENT_APPROVAL`, so the button row had become a wall.
 *
 * The same control serves both kinds of task and the difference is entirely in
 * what it CONTAINS — `availableTransitions` doing its job:
 *
 *   internal / personal   every status except FOR_CLIENT_APPROVAL, always
 *   client                only the legal next moves, exactly as before
 *
 * ⚠️ P7-61 TOOK THE DETAIL HEADER OFF IT FOR CLIENT WORK. A menu is the right
 * shape for seven destinations and the wrong one for two: on a client task it
 * drew "Pass QA" and "Send back to PIC" as two identical grey lines, behind a
 * click, under a banded heading. That header is a row of colour-coded buttons
 * now (`[id]/task-actions.tsx`). This control keeps every OTHER call site —
 * every list row and board card of either kind, and the detail header of
 * internal and personal work, which is where the seven live.
 *
 * ILLEGAL MOVES ARE NOT RENDERED DISABLED. A greyed row invites "why can't I",
 * and on client work the answer is a gate that exists to protect somebody
 * outside the company rather than an arbitrary rule. This control has never
 * shown a move the server would refuse and does not start here.
 *
 * The one thing that IS shown unavailable is a move whose PRECONDITION is
 * unmet — "Send for QA" with an empty resolution. That is not a gate on who you
 * are, it is a field somebody has to fill in, so the row stays and says so.
 * Hiding it would leave no way to discover why QA is unreachable.
 */

/**
 * Not started / Active / Done, DERIVED rather than listed.
 *
 * A second hand-written order beside `TASK_STATUSES` is a copy that drifts the
 * next time a status is added, and the enum is already the authority on order.
 * So the band comes from the two facts the schema module already exports:
 * `INITIAL_TASK_STATUS` is where work has not begun, `isTerminal` is where it
 * has finished, and everything between them is in flight.
 */
const BANDS = ["Not started", "Active", "Done", "Closed"] as const;

function band(status: TaskStatus): (typeof BANDS)[number] {
  if (status === INITIAL_TASK_STATUS) return "Not started";
  // CLOSED IS NOT THE SAME AS DONE, and the split is the enum's own.
  // `COMPLETED` and `COMPLETED_NO_RESPONSE` are terminal — the work is over and
  // nothing follows. `FOR_CLIENT_APPROVAL` is the last ACTIVE stage: the work is
  // finished but the request is not, because somebody outside the company still
  // has to answer. Filing it under "Done" would say the task was finished the
  // moment it was sent, which is the reading Gate 3 exists to prevent.
  if (isTerminal(status)) return "Closed";
  return status === "FOR_CLIENT_APPROVAL" ? "Done" : "Active";
}

export function TaskStatusSelect({
  taskId,
  status,
  viewer,
  task,
  resolutionMissing = false,
  align = "start",
  variant = "chip",
  className,
  onMoved,
  beforeMove,
}: {
  taskId: string;
  status: TaskStatus;
  viewer: { isAssignee: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean };
  /** Which of the three kinds of work this is. It decides the whole menu. */
  task: { request_id: string | null; is_personal: boolean };
  /**
   * The SAVED resolution is empty. The database checks the saved value, so a
   * caller must not pass an unsaved draft here — the row would offer a move the
   * server then refuses.
   */
  resolutionMissing?: boolean;
  align?: "start" | "center" | "end";
  /**
   * `control` is the task detail header of INTERNAL and PERSONAL work, where it
   * is the only thing that moves the task (P7-60 deleted the promoted buttons
   * that used to sit beside it; P7-61 gave client work buttons of its own). It
   * is the status LABEL in a raised, button-height shell, because a status drawn
   * at chip weight in a header row reads as a label — and this is not a label.
   *
   * `chip` states the status and opens the list, in a text run.
   *
   * `compact` is a glyph with no label, for a LIST ROW or a BOARD CARD. There the
   * group heading or the column already carries the status, and repeating it on
   * every row would draw eight identical pills under a heading that says the
   * same word — which is exactly why the list has no status column. The control
   * still has to be reachable, so it becomes an action rather than a value.
   */
  variant?: "chip" | "compact" | "control";
  className?: string;
  /** The detail page has local state to reset; a row only needs the refresh. */
  onMoved?: () => void;
  /**
   * P7-60 — run and AWAIT before the move goes to the server.
   *
   * It exists for one caller and one reason: the task detail commits its
   * debounced resolution here, because that field is the precondition of a move
   * this menu offers. A list row passes nothing.
   */
  beforeMove?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const move = useTaskTransition({
    taskId,
    beforeMove,
    onMoved: () => {
      setOpen(false);
      setQuery("");
      onMoved?.();
    },
  });

  const transitions = availableTransitions(status, viewer, task);
  const category = taskCategory(task);

  const matches = query.trim()
    ? transitions.filter((transition) =>
        // Matched on the LABEL, which is what is on screen — "Send for QA"
        // should be findable by typing "send", not only by typing "QA".
        transition.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : transitions;

  /**
   * P7-61 — THE NOTE MOVED OUT OF HERE AND INTO A DIALOG.
   *
   * A comment-requiring move used to swap this 288px popover's body for a
   * three-row textarea, under the menu's own heading, for the most consequential
   * thing anybody types on a task. It is a `TransitionCommentDialog` now, shared
   * with the button row client work gets (`transition.tsx`).
   *
   * ⚠️ SO THE POPOVER HAS TO CLOSE FIRST. The dialog is rendered as this
   * component's SIBLING, not inside the popover: a dialog nested in a popover is
   * unmounted the moment the popover dismisses, and it dismisses as soon as
   * focus moves into the dialog.
   */
  const pending = move.pending;

  /*
   * Nothing to offer, so nothing to click. An inert dropdown would promise an
   * interaction and then refuse it; the plain chip is honest. The two reasons
   * are different facts, so the tooltip says which one it is.
   */
  if (transitions.length === 0) {
    const why = isTerminal(status) ? "This task is finished." : "This is with somebody else.";

    // A compact trigger that cannot open would be an invisible dead control on a
    // row, so it renders as nothing at all — the group heading already says
    // where the task is. The chip form still shows the status, because on the
    // detail page it is the only thing that does.
    if (variant === "compact") return null;

    return (
      <span title={why}>
        <TaskStatusBadge status={status} className={className} />
      </span>
    );
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}>
        <PopoverTrigger
          disabled={pending}
          title={
            variant === "compact" ? `Move — currently ${TASK_STATUS_LABELS[status]}` : undefined
          }
          aria-label={`Status: ${TASK_STATUS_LABELS[status]}. Change it.`}
          className={cn(
            variant === "compact"
              ? cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
                  "hover:bg-accent hover:text-foreground",
                )
              : variant === "control"
                ? /*
                   THE PRIMARY BUTTON'S OWN CLASSES, not a hand-rolled copy of
                   them. It is the page's one action now (P7-60), so it is the
                   page's primary control — and `buttonVariants` carries the
                   brand fill, the grade, the lift, the press, the focus ring and
                   the disabled state together. Rebuilding that from tokens here
                   is how the two drift the next time the button changes.
                */
                  cn(buttonVariants({ variant: "default" }), "gap-2")
                : "inline-flex shrink-0 items-center gap-1 rounded-md hover:opacity-90",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}>
          {variant === "compact" ? (
            <ArrowRightLeft className="size-3.5" aria-hidden />
          ) : variant === "control" ? (
            <>
              {/*
              ⚠️ THE LABEL, NOT THE CHIP, AND THAT IS DELIBERATE.

              A tone-coloured chip inside a brand-filled button is two fills
              fighting on one control, and the inner one would have to hold 4.5:1
              against `--primary` rather than against its own subtle — which
              `--warning-subtle` on blue does not.

              Nothing is lost: §5.5 asks that state never rest on colour alone,
              and the state is the WORD here. The tone still reads on every chip
              elsewhere on the page — the track above says where the work is, and
              `status-badge.tsx` stays the only place a status maps to a colour.
            */}
              {TASK_STATUS_LABELS[status]}
              <ChevronDown className="size-3.5 shrink-0 opacity-80" aria-hidden />
            </>
          ) : (
            <>
              <TaskStatusBadge status={status} />
              {/* The chip alone looks like every other read-only pill in the app.
                The chevron is the only thing marking this one as a control. */}
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </>
          )}
        </PopoverTrigger>

        <PopoverContent align={align} className="w-72">
          <PopoverHeader className="gap-0.5">
            <PopoverTitle className="text-xs">Move this task</PopoverTitle>
            {/* Says WHY the list is the length it is. On client work a short
              list looks like a bug until you know a gate is holding it. */}
            <p className="text-2xs text-muted-foreground">
              {category === "request"
                ? "Client work — only the next step in the approved flow."
                : "Internal work — any stage, in any order."}
            </p>
          </PopoverHeader>

          {/*
          A SEARCH BOX, and the plan said it was not needed at eight
          statuses. It was right about eight and wrong about the list: with
          free movement an internal task offers SEVEN moves at once, and
          typing three letters beats reading four headings — which is why the
          reference has one. It filters and never hides the current status,
          and it does not appear on client work, where the list is one or two
          rows and a search box over two rows is furniture.
        */}
          {transitions.length > 4 ? (
            <div className="border-b p-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  autoFocus
                  value={query}
                  placeholder="Search stages"
                  aria-label="Search stages"
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </div>
          ) : null}

          <div className="max-h-80 overflow-y-auto py-1">
            {matches.length === 0 ? (
              <p className="px-3 py-3 text-2xs text-muted-foreground">No stage by that name.</p>
            ) : null}

            {BANDS.map((label) => {
              const inBand = matches.filter((transition) => band(transition.to) === label);
              // The current status' own band still draws its heading, because
              // the ticked row lives in it. A band with neither is not drawn.
              // The current status keeps its row whatever is typed: it is a
              // statement of where the task IS, not one of the options.
              const showsCurrent = band(status) === label;
              if (inBand.length === 0 && !showsCurrent) return null;

              return (
                <div key={label} className="py-0.5">
                  <p className="px-3 py-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {label}
                  </p>

                  {showsCurrent ? (
                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium">
                      <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                      {TASK_STATUS_LABELS[status]}
                      <span className="ml-auto text-2xs text-muted-foreground">now</span>
                    </div>
                  ) : null}

                  {inBand.map((transition) => {
                    // Not a gate — a field somebody has to fill in first, so
                    // the row stays and the reason is discoverable.
                    const blocked = transition.requires === "resolution" && resolutionMissing;

                    return (
                      <button
                        key={`${transition.from}-${transition.to}`}
                        type="button"
                        disabled={pending || blocked}
                        onClick={() => {
                          // A comment move opens a DIALOG, so this popover has
                          // to be gone before it does — see the note above.
                          if (transition.requires === "comment") setOpen(false);
                          move.choose(transition);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                          "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                          "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
                        )}>
                        {/* Indented to sit under the tick rather than beside
                          it, so the current row reads as the odd one out. */}
                        <span className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          {/* The transition's OWN wording where it has one —
                            "Send for QA" says more than "For QA". Free
                            movement has no wording of its own, and there
                            `label` is already the status name. */}
                          {transition.label}
                        </span>
                        {blocked ? (
                          <span className="shrink-0 text-2xs text-muted-foreground">
                            needs a resolution
                          </span>
                        ) : transition.requires === "comment" ? (
                          <span className="shrink-0 text-2xs text-muted-foreground">
                            needs a note
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {move.error && !move.prompt ? (
            <p role="alert" className="border-t px-3 py-2 text-2xs text-destructive">
              {move.error}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>

      {/* THE SIBLING, not a child of the popover. */}
      <TransitionCommentDialog taskId={taskId} state={move} />
    </>
  );
}

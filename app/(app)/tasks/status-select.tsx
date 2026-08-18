"use client";

import { ArrowRightLeft, Check, ChevronDown, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { TaskStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUS_LABELS,
  availableTransitions,
  isTerminal,
  taskCategory,
  type TaskStatus,
  type Transition,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { transitionTask } from "./actions";

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
}: {
  taskId: string;
  status: TaskStatus;
  viewer: { isPic: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean };
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
   * `chip` states the status and opens the list — the task detail, where nothing
   * else on screen says where the work is.
   *
   * `compact` is a glyph with no label, for a LIST ROW or a BOARD CARD. There the
   * group heading or the column already carries the status, and repeating it on
   * every row would draw eight identical pills under a heading that says the
   * same word — which is exactly why the list has no status column. The control
   * still has to be reachable, so it becomes an action rather than a value.
   */
  variant?: "chip" | "compact";
  className?: string;
  /** The detail page has local state to reset; a row only needs the refresh. */
  onMoved?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  /** Non-null while a comment-requiring move waits for its comment. */
  const [prompt, setPrompt] = useState<Transition | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");

  const transitions = availableTransitions(status, viewer, task);
  const category = taskCategory(task);

  const matches = query.trim()
    ? transitions.filter((transition) =>
        // Matched on the LABEL, which is what is on screen — "Send for QA"
        // should be findable by typing "send", not only by typing "QA".
        transition.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : transitions;

  function reset() {
    setPrompt(null);
    setComment("");
    setError(null);
    setQuery("");
  }

  function commit(transition: Transition, withComment?: string) {
    setError(null);
    startTransition(async () => {
      const result = await transitionTask(taskId, {
        to_status: transition.to,
        ...(withComment ? { comment: withComment } : {}),
      });

      if (!result.ok) {
        setError(result.error ?? "That did not go through.");
        return;
      }

      toast.success(transition.label);
      setOpen(false);
      reset();
      onMoved?.();
      router.refresh();
    });
  }

  function choose(transition: Transition) {
    // A move needing a comment asks for it in place rather than moving first and
    // hoping somebody adds one afterwards. Everything else goes straight
    // through — a confirmation step on a reversible move only teaches people to
    // click past dialogs.
    if (transition.requires === "comment") {
      setPrompt(transition);
      return;
    }
    commit(transition);
  }

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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing mid-comment throws the draft away deliberately: a half-typed
        // note reappearing next to a DIFFERENT chosen move would be worse.
        if (!next) reset();
      }}>
      <PopoverTrigger
        disabled={pending}
        title={variant === "compact" ? `Move — currently ${TASK_STATUS_LABELS[status]}` : undefined}
        aria-label={`Status: ${TASK_STATUS_LABELS[status]}. Change it.`}
        className={cn(
          variant === "compact"
            ? cn(
                "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
                "hover:bg-accent hover:text-foreground",
              )
            : "inline-flex shrink-0 items-center gap-1 rounded-md hover:opacity-90",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}>
        {variant === "compact" ? (
          <ArrowRightLeft className="size-3.5" aria-hidden />
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
        {prompt ? (
          <div className="space-y-2.5 p-3">
            <div className="space-y-1.5">
              <Label htmlFor={`move-comment-${taskId}`}>
                {prompt.to === "WAITING_FOR_INFO"
                  ? "What are you waiting for?"
                  : prompt.to === "ONGOING"
                    ? "What needs changing?"
                    : "Add a comment"}
              </Label>
              <Textarea
                id={`move-comment-${taskId}`}
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={
                  prompt.to === "ONGOING"
                    ? "e.g. The logo is the old one — please use the 2026 mark."
                    : "e.g. Waiting on the client to confirm which of the two headlines."
                }
              />
              <p className="text-2xs text-muted-foreground">
                Recorded on the task, and counted toward how long this spent waiting.
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                loading={pending}
                disabled={comment.trim().length === 0}
                onClick={() => commit(prompt, comment)}>
                {prompt.label}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPrompt(null)}>
                Back
              </Button>
            </div>

            {error ? (
              <p role="alert" className="text-2xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <>
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
                          onClick={() => choose(transition)}
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
                            <span className="shrink-0 text-2xs text-muted-foreground">needs a resolution</span>
                          ) : transition.requires === "comment" ? (
                            <span className="shrink-0 text-2xs text-muted-foreground">needs a note</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {error ? (
              <p role="alert" className="border-t px-3 py-2 text-2xs text-destructive">
                {error}
              </p>
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

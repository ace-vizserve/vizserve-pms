import { Circle, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatDate } from "@/lib/dates";
import type { VizservePmsClientDecision } from "@/lib/database.types";
import {
  TASK_STATUS_LABELS,
  isTerminal,
  type TaskCategory,
  type TaskStatus,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

/**
 * P7-28 — the three gates, as a rail.
 *
 * The History card underneath is the EVIDENCE: every move, who made it, when,
 * and what they said. It is complete and it is unreadable at a glance — a task
 * that has been round QA twice runs a dozen entries, and none of them says
 * which of the three gates the work is currently sitting behind.
 *
 * This is the summary. One line per stage, each either passed, current or still
 * ahead. The trail stays exactly where it was, underneath and quieter, because
 * the two answer different questions: "where is this" and "what happened to it".
 *
 * ⚠️ IT MUST NOT INVENT A GATE A CATEGORY DOES NOT HAVE.
 *
 *   request   five stages — the client asked, the TL approved (Gate 1), the
 *             work, internal QA (Gate 2), the client signs off (Gate 3).
 *   internal  four — nobody outside the company is involved, so there is no
 *             Gate 3 to draw. A greyed-out one would report closed work as
 *             unfinished, for ever.
 *   personal  three — P7-02 lets the owner close it directly, so there is no
 *             QA stage either.
 *
 * A REVISION_REQUESTED at Gate 3 is a DISTINCT STATE, not a missing tick. The
 * client answered, and the answer was "not yet". Rendering it as an empty
 * circle would read as "the client has not looked" — the opposite of what
 * happened, and the one thing the PIC most needs to know.
 */

type StepState = "done" | "current" | "pending" | "attention";

type Step = {
  label: string;
  state: StepState;
  /** Date, person, or what the client said. One short line. */
  meta?: string | null;
};

type RequestGate = {
  submittedAt: string | null;
  requesterName: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
};

type ClientDecision = {
  decision: VizservePmsClientDecision;
  createdAt: string;
  approverName: string | null;
};

const MARKER: Record<StepState, { icon: LucideIcon; className: string; word: string }> = {
  // Shape as well as colour, in all four: greyscale has to separate them (§5.5),
  // and a tick, a filled dot, an empty ring and an alert do.
  done: { icon: CircleCheck, className: "text-success", word: "done" },
  current: { icon: CircleDot, className: "text-primary", word: "now" },
  pending: { icon: Circle, className: "text-foreground-faint", word: "still to come" },
  attention: { icon: CircleAlert, className: "text-warning", word: "needs attention" },
};

export function LifecycleRail(props: {
  status: TaskStatus;
  category: TaskCategory;
  createdAt: string;
  createdByName: string | null;
  picName: string | null;
  qaName: string | null;
  /** Gate 1, and who asked in the first place. Null for work with no client. */
  request: RequestGate | null;
  /** Gate 3 — the client's most recent answer, where they have given one. */
  decision: ClientDecision | null;
}) {
  const steps = buildSteps(props);

  return (
    <ol className="mb-3 space-y-0 border-b pb-3">
      {steps.map((step, index) => {
        const marker = MARKER[step.state];
        const Icon = marker.icon;
        const last = index === steps.length - 1;

        return (
          <li key={step.label} className={cn("relative flex gap-2.5", last ? "pb-0" : "pb-2.5")}>
            {/* The rail itself. Absolutely positioned so it runs from under one
                marker to the next without either row having to know the other's
                height — and absent on the last, which has nothing to join. */}
            {!last ? (
              <span aria-hidden className="absolute top-5 bottom-0 left-[7.5px] w-px bg-border" />
            ) : null}

            <Icon className={cn("mt-0.5 size-4 shrink-0", marker.className)} aria-hidden />

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm",
                  step.state === "current" ? "font-medium" : null,
                  step.state === "pending" ? "text-muted-foreground" : null,
                )}>
                {step.label}
                {/* The marker is a colour and a shape; this is the word. */}
                <span className="sr-only"> — {marker.word}</span>
              </p>
              {step.meta ? (
                <p className="text-2xs wrap-break-word text-muted-foreground">{step.meta}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The stages, and how far down them this task has got.
 *
 * `reached` is the index of the furthest stage the task is at. Everything
 * before it has passed; the stage itself is CURRENT unless the task is
 * finished, in which case it has passed too; everything after is still ahead.
 * One rule rather than a state written by hand per row, so a stage cannot be
 * given the wrong one.
 */
function buildSteps({
  status,
  category,
  createdAt,
  createdByName,
  picName,
  qaName,
  request,
  decision,
}: {
  status: TaskStatus;
  category: TaskCategory;
  createdAt: string;
  createdByName: string | null;
  picName: string | null;
  qaName: string | null;
  request: RequestGate | null;
  decision: ClientDecision | null;
}): Step[] {
  const finished = isTerminal(status);

  /*
   * WHICH STAGE THE STATUS SITS IN.
   *
   * `inQa` deliberately does nothing on personal work below. Personal work CAN
   * reach FOR_QA through the dropdown — P7-13a's free movement — but it has no
   * QA STAGE, and drawing one because a status happens to be reachable is
   * exactly the invented gate this component must not have. The current row
   * names the real status underneath, so nothing is hidden either way.
   */
  const inQa = status === "FOR_QA" || status === "QA_IN_PROGRESS";
  const atClient = status === "FOR_CLIENT_APPROVAL";

  /** The one line that says what is actually happening right now. */
  const now = TASK_STATUS_LABELS[status];

  if (category === "request") {
    // The task exists BECAUSE the request was approved — `approve_request` is
    // the statement that creates it — so the first two stages are always past.
    const reached = finished || atClient ? 4 : inQa ? 3 : 2;

    return [
      {
        label: "Requested",
        state: "done",
        meta: line(request?.submittedAt, request?.requesterName),
      },
      {
        label: "Gate 1 · approved by the team leader",
        state: "done",
        meta: line(request?.reviewedAt, request?.reviewedByName),
      },
      stage("Work in progress", 2, reached, finished, now, who("PIC", picName, "No PIC yet")),
      stage("Gate 2 · internal QA", 3, reached, finished, now, who("QA", qaName, "No reviewer yet")),
      clientGate(4, reached, finished, status, decision),
    ];
  }

  if (category === "personal") {
    const reached = finished ? 2 : 1;

    return [
      { label: "Made it for yourself", state: "done", meta: line(createdAt, createdByName) },
      stage("Work in progress", 1, reached, finished, now, null),
      // P7-02 — no QA stage and no client stage. You made it, you close it.
      stage("Done", 2, reached, finished, now, null),
    ];
  }

  const reached = finished ? 3 : inQa ? 2 : 1;

  return [
    { label: "Created", state: "done", meta: line(createdAt, createdByName) },
    stage("Work in progress", 1, reached, finished, now, who("PIC", picName, "No PIC yet")),
    stage("Internal QA", 2, reached, finished, now, who("QA", qaName, "No reviewer yet")),
    // No Gate 3. There is nobody outside the company to sign this off.
    stage("Done", 3, reached, finished, now, null),
  ];
}

/** One stage, its state decided by where it sits against `reached`. */
function stage(
  label: string,
  index: number,
  reached: number,
  finished: boolean,
  now: string,
  seat: string | null,
): Step {
  if (index < reached || (index === reached && finished)) {
    return { label, state: "done", meta: seat };
  }
  if (index > reached) return { label, state: "pending", meta: null };

  // The current stage names the ACTUAL status, so a parked task reads
  // "Work in progress · Waiting for info" rather than claiming progress.
  return { label, state: "current", meta: [now, seat].filter(Boolean).join(" · ") };
}

/** Gate 3, where the client's own answer decides the state rather than the status. */
function clientGate(
  index: number,
  reached: number,
  finished: boolean,
  status: TaskStatus,
  decision: ClientDecision | null,
): Step {
  const label = "Gate 3 · client sign-off";

  // "The clock ran out" is not "the client approved". The two statuses are
  // deliberately distinct and Phase 6 reports the split, so the rail says which.
  if (status === "COMPLETED_NO_RESPONSE") {
    return { label, state: "done", meta: line(decision?.createdAt, null, "Closed with no response") };
  }

  if (decision?.decision === "REVISION_REQUESTED") {
    // The client looked and asked for changes, and the work has gone back
    // round. An empty circle here would say they had not looked at all.
    return {
      label,
      state: finished ? "done" : "attention",
      meta: line(decision.createdAt, decision.approverName, "Changes requested"),
    };
  }

  if (index < reached || (index === reached && finished)) {
    return {
      label,
      state: "done",
      meta: line(decision?.createdAt, decision?.approverName, "Approved"),
    };
  }
  if (index > reached) return { label, state: "pending", meta: null };

  return { label, state: "current", meta: "Sent — waiting on the client" };
}

/** `QA Kurt Arciga`, or the sentence that says there is nobody in the seat. */
function who(seat: string, name: string | null, empty: string): string {
  return name ? `${seat} ${name}` : empty;
}

/** `19 Aug · Maria Santos`, dropping whichever half is missing. */
function line(
  when: string | null | undefined,
  name: string | null | undefined,
  prefix?: string,
): string | null {
  const parts = [prefix, when ? formatDate(when.slice(0, 10)) : null, name].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

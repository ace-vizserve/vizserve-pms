import { Check, Circle, CircleAlert, CircleDot } from "lucide-react";
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
 * P7-28 / P7-57 — the three gates, as a track across the top of the page.
 *
 * The History card underneath is the EVIDENCE: every move, who made it, when,
 * and what they said. It is complete and it is unreadable at a glance — a task
 * that has been round QA twice runs a dozen entries, and none of them says
 * which of the three gates the work is currently sitting behind.
 *
 * This is the summary. One stop per stage, each either passed, current or still
 * ahead. The trail stays in the right-hand rail, quieter, because the two answer
 * different questions: "where is this" and "what happened to it".
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
  /**
   * P7-59 — NULL FOR EVERYONE BUT A DEPARTMENT LEAD, and `line()` drops it.
   *
   * The client's name lives on the request row, which RLS scopes to leads
   * because the client is never told who at VizServe holds their task and the
   * anonymity is meant to run both ways. The stage still draws, and still dates
   * itself from the brief — "Requested · 1 Sept" is the useful half anyway.
   */
  requesterName: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
};

type ClientDecision = {
  decision: VizservePmsClientDecision;
  createdAt: string;
  approverName: string | null;
};

const MARKER: Record<
  StepState,
  { icon: LucideIcon; className: string; word: string; pulse?: string }
> = {
  // Shape as well as colour, in all four: greyscale has to separate them (§5.5),
  // and a tick, a filled dot, an empty ring and an alert do.
  //
  // `pulse` is the FOURTH carrier and it is only ever on the LIVE stage — the
  // one place on the page where something is still moving. It is decoration
  // over three carriers that already work without it, and the utility itself
  // sits behind `prefers-reduced-motion`, so it can vanish entirely and the
  // track still reads. Its tint is named per state: a brand-blue halo on
  // `attention` would report a client asking for changes in the same colour as
  // ordinary progress.
  // A FILLED green disc, not an outline tick. The outline read as a hairline
  // at 16px and a passed gate has to be obvious from across the header.
  // A RAISED green chip, not an outline tick and not a flat disc. Depth is
  // outward (§1.5): its own fill, the `grade-chip` wash for a lit top edge and
  // `shadow-raised` under it, so a passed gate sits ON the header rather than
  // being painted onto it — and reads as green from across the page, which a
  // 1px outline at 16px did not.
  done: {
    icon: Check,
    className: "border border-success bg-success grade-chip text-background shadow-raised",
    word: "done",
  },
  current: {
    icon: CircleDot,
    className: "text-primary",
    word: "now",
    pulse: "pulse-now",
  },
  pending: {
    icon: Circle,
    className: "text-foreground-faint",
    word: "still to come",
  },
  attention: {
    icon: CircleAlert,
    className: "text-warning",
    word: "needs attention",
    pulse: "pulse-now [--pulse-tint:var(--warning)]",
  },
};

export function GateTrack(props: {
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
    /*
      HORIZONTAL, ACROSS THE TOP, AND ABOVE BOTH COLUMNS.

      It used to be a vertical rail stacked on top of the history trail inside
      one card, and the two are different questions drawn as one object: this is
      a ROUTE with fixed stops, ordered by the pipeline, and the trail under it
      is a LOG ordered by time, newest first. A pipeline sitting directly above a
      reverse-chronological list made the first look like the beginning of the
      second.

      It is up here because "how far along is this" is a header fact — it belongs
      beside the status chip and the button that moves it, not three cards down
      the right-hand rail.

      Vertical again below `sm`: five stops with two lines of meta each cannot be
      laid side by side in 390px without either truncating the labels or scrolling
      the page sideways, and §9 forbids the second.
    */
    <ol className="flex flex-col gap-2.5 p-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-y-3">
      {steps.map((step, index) => {
        const marker = MARKER[step.state];
        const Icon = marker.icon;

        return (
          <li
            key={step.label}
            className={cn(
              "flex min-w-0 items-start gap-2.5",
              // Only the connectors stretch, so the free width falls BETWEEN
              // stops rather than being shared out inside their labels.
              index === 0 ? "sm:flex-none" : "sm:flex-1",
            )}>
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "mt-[9px] hidden h-0.5 min-w-4 flex-1 rounded-full sm:block",
                  // Filled only where the work has actually passed.
                  step.state === "done" || steps[index - 1].state === "done"
                    ? "bg-success"
                    : "bg-border",
                )}
              />
            ) : null}

            {/* The halo needs a box to ring, and an icon glyph is not one —
                the ring inherits this span's radius and size, so it stays
                circular against a circular marker at any type scale. */}
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                marker.className,
                marker.pulse,
              )}>
              <Icon className={cn(step.state === "done" ? "size-2.5" : "size-4")} aria-hidden />
            </span>

            <div className="min-w-0">
              <p
                className={cn(
                  "text-xs leading-tight font-semibold",
                  step.state === "pending" ? "font-medium text-muted-foreground" : null,
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
      stage(
        "Gate 2 · internal QA",
        3,
        reached,
        finished,
        now,
        who("QA", qaName, "No reviewer yet"),
      ),
      clientGate(4, reached, finished, status, decision),
    ];
  }

  if (category === "personal") {
    const reached = finished ? 2 : 1;

    return [
      {
        label: "Made it for yourself",
        state: "done",
        meta: line(createdAt, createdByName),
      },
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
  return {
    label,
    state: "current",
    meta: [now, seat].filter(Boolean).join(" · "),
  };
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
    return {
      label,
      state: "done",
      meta: line(decision?.createdAt, null, "Closed with no response"),
    };
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

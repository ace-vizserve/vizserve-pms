import { Star } from "lucide-react";

import { metaDate, metaLine, type Step } from "@/components/stage-track";
import { Chip, TaskStatusBadge } from "@/components/status-badge";
import { RichText } from "@/components/ui/rich-text";
import type {
  VizservePmsClientDecision,
  VizservePmsRequestStatus,
  VizservePmsTaskStatus,
} from "@/lib/database.types";
import { formatDateTime, formatDuration } from "@/lib/dates";
import { cn } from "@/lib/utils";

export type ProgressHistoryRow = {
  from_status: VizservePmsTaskStatus | null;
  to_status: VizservePmsTaskStatus;
  actor_id: string | null;
  comment: string | null;
  is_override: boolean;
  created_at: string;
};

export type ProgressClientDecision = {
  decision: VizservePmsClientDecision;
  approver_name: string | null;
  comment: string | null;
  created_at: string;
};

export type ProgressFeedback = { rating: number; comment: string | null; created_at: string };

export type ProgressGateDecision = {
  decision: string;
  reason: string | null;
  approver_id: string | null;
  created_at: string;
};

const QA_STATES: VizservePmsTaskStatus[] = ["FOR_QA", "QA_IN_PROGRESS"];
const DONE: VizservePmsTaskStatus[] = ["COMPLETED", "COMPLETED_NO_RESPONSE"];

/** A QA reviewer moving work back out of QA, rather than on to the client. */
export function isQaReturn(row: ProgressHistoryRow): boolean {
  return (
    row.from_status !== null &&
    QA_STATES.includes(row.from_status) &&
    !QA_STATES.includes(row.to_status) &&
    row.to_status !== "FOR_CLIENT_APPROVAL" &&
    !DONE.includes(row.to_status)
  );
}

/**
 * P15-01 — the stage track for a request that has NO TASK YET: waiting at
 * Gate 1, or stopped there. Once the request is approved the page draws the
 * task page's own `GateTrack` instead, so the two pages show one pipeline.
 */
export function preTaskSteps(
  status: VizservePmsRequestStatus,
  submittedAt: string | null,
  requesterName: string,
  decision: { at: string; by: string | null } | null,
): Step[] {
  // P16-01 — a form that needs no approval has no pipeline to draw.
  if (status === "SUBMITTED") {
    return [
      { label: "Requested", state: "done", meta: metaLine(metaDate(submittedAt), requesterName) },
      { label: "Recorded · this form needs no approval", state: "done" },
    ];
  }

  const stopped = status === "RETURNED" || status === "REJECTED" || status === "CANCELLED";

  return [
    { label: "Requested", state: "done", meta: metaLine(metaDate(submittedAt), requesterName) },
    {
      label: stopped
        ? status === "RETURNED"
          ? "Gate 1 · returned to the client"
          : status === "CANCELLED"
            ? "Gate 1 · cancelled"
            : "Gate 1 · rejected"
        : "Gate 1 · team leader review",
      state: stopped ? "attention" : "current",
      meta: stopped ? metaLine(metaDate(decision?.at), decision?.by) : "Waiting for a decision",
    },
    { label: "Work in progress", state: "pending" },
    { label: "Gate 2 · internal QA", state: "pending" },
    { label: "Gate 3 · client approval", state: "pending" },
  ];
}

type Entry = {
  at: string;
  title: React.ReactNode;
  who?: string | null;
  note?: string | null;
  tone: "good" | "bad" | "neutral";
  after?: string;
};

const GATE_TITLES: Record<string, string> = {
  approved: "Approved at Gate 1",
  returned: "Returned to the client",
  rejected: "Rejected at Gate 1",
};

const CLIENT_TITLES: Record<VizservePmsClientDecision, string> = {
  APPROVED: "The client approved the work",
  REVISION_REQUESTED: "The client asked for changes",
  AUTO_COMPLETED: "Closed with no answer from the client",
};

/**
 * P15-01 — EVERYTHING THAT HAPPENED, NEWEST FIRST, in the task page's History
 * shape: one line per step, a note under it only when somebody wrote one.
 *
 * It merges what lives in four places — the request (submitted), Gate 1's
 * decision, the task's moves, and the client's answers and rating — because a
 * request is one story and a lead reading it should not have to open the task
 * to learn that QA sent it back.
 */
export function RequestActivity({
  submittedAt,
  requesterName,
  gateDecisions,
  history,
  clientDecisions,
  feedback,
  nameOf,
}: {
  submittedAt: string | null;
  requesterName: string;
  gateDecisions: ProgressGateDecision[];
  history: ProgressHistoryRow[];
  clientDecisions: ProgressClientDecision[];
  feedback: ProgressFeedback[];
  nameOf: Map<string, string>;
}) {
  const name = (id: string | null) => (id ? (nameOf.get(id) ?? "Someone") : "System");
  const entries: Entry[] = [];

  if (submittedAt) {
    entries.push({ at: submittedAt, title: "Submitted", who: requesterName, tone: "neutral" });
  }

  for (const decision of gateDecisions) {
    entries.push({
      at: decision.created_at,
      title: GATE_TITLES[decision.decision] ?? decision.decision,
      who: decision.approver_id ? name(decision.approver_id) : null,
      note: decision.reason,
      tone: decision.decision === "approved" ? "good" : "bad",
    });
  }

  for (const row of history) {
    // The task's first row is the approval itself creating it — already said.
    if (row.from_status === null) continue;
    const qaReturn = isQaReturn(row);
    entries.push({
      at: row.created_at,
      title: (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {qaReturn ? "Sent back by QA" : "Moved to"}
          <TaskStatusBadge status={row.to_status} />
          {row.is_override ? <Chip tone="warning" label="Forced" /> : null}
        </span>
      ),
      who: name(row.actor_id),
      note: row.comment,
      tone: qaReturn ? "bad" : DONE.includes(row.to_status) ? "good" : "neutral",
    });
  }

  for (const decision of clientDecisions) {
    entries.push({
      at: decision.created_at,
      title: CLIENT_TITLES[decision.decision],
      who: decision.approver_name,
      note: decision.comment,
      tone: decision.decision === "REVISION_REQUESTED" ? "bad" : "good",
    });
  }

  for (const row of feedback) {
    entries.push({
      at: row.created_at,
      title: (
        <span className="inline-flex items-center gap-1.5">
          Rated by the client
          <span className="inline-flex text-warning" aria-label={`${row.rating} out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                aria-hidden
                className={cn("size-3.5", n <= row.rating ? "fill-current" : "opacity-30")}
              />
            ))}
          </span>
        </span>
      ),
      note: row.comment,
      tone: row.rating >= 4 ? "good" : row.rating <= 2 ? "bad" : "neutral",
    });
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));
  for (let index = 1; index < entries.length; index += 1) {
    const minutes = Math.round((Date.parse(entries[index]!.at) - Date.parse(entries[index - 1]!.at)) / 60_000);
    if (minutes > 0) entries[index]!.after = elapsed(minutes);
  }
  entries.reverse();

  if (entries.length === 0) return <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>;

  return (
    <ol className="space-y-1.5">
      {entries.map((entry, index) => (
        <li
          key={`${entry.at}-${index}`}
          className={cn(
            "border-l-2 pl-2.5 text-sm",
            entry.tone === "good" && "border-success",
            entry.tone === "bad" && "border-warning",
          )}
        >
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{entry.title}</span>
            <span className="text-xs text-muted-foreground">
              {metaLine(entry.who, formatDateTime(entry.at), entry.after ? `${entry.after} later` : null)}
            </span>
          </div>
          {entry.note ? (
            <RichText html={entry.note} className="mt-0.5 text-sm text-muted-foreground" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Minutes to "3m", "2h 5m", "4d 2h". */
export function elapsed(minutes: number): string {
  if (minutes < 60 * 24) return formatDuration(minutes);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}


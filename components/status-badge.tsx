import { cn } from "@/lib/utils";
import type { VizservePmsRequestStatus, VizservePmsTaskStatus } from "@/lib/database.types";
import { TASK_STATUS_LABELS } from "@/lib/schemas/tasks";

/**
 * Status pills for the canonical status sets (docs/01-updated-workflow.md §3).
 *
 * Two rules encoded here rather than left to call sites:
 *
 *   1. State is never conveyed by colour alone — every pill carries its label,
 *      so it survives greyscale, a screenshot and a printed queue.
 *   2. The label is human wording, not the enum. `PENDING_REVIEW` is a database
 *      value; "Awaiting review" is what a Team Leader scanning a queue reads.
 *      The enum stays canonical underneath and is never invented around.
 */

const REQUEST_STATUS: Record<
  VizservePmsRequestStatus,
  { label: string; className: string }
> = {
  DRAFT: { label: "Draft", className: "bg-muted text-muted-foreground" },
  SUBMITTED: { label: "Submitted", className: "bg-muted text-muted-foreground" },
  PENDING_REVIEW: { label: "Awaiting review", className: "bg-warning-subtle text-warning" },
  APPROVED: { label: "Approved", className: "bg-success-subtle text-success" },
  RETURNED: { label: "Returned", className: "bg-info-subtle text-info" },
  REJECTED: { label: "Rejected", className: "bg-destructive/10 text-destructive" },
};

export function RequestStatusBadge({
  status,
  className,
}: {
  status: VizservePmsRequestStatus;
  className?: string;
}) {
  const config = REQUEST_STATUS[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground",
  };

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap",
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  );
}

export const REQUEST_STATUS_OPTIONS = (
  Object.keys(REQUEST_STATUS) as VizservePmsRequestStatus[]
).map((value) => ({ value, label: REQUEST_STATUS[value].label }));

/**
 * Narrows a URL parameter to a real status.
 *
 * Filters come from the query string, so the value is whatever someone typed.
 * An unknown status is dropped rather than passed to Postgres, where it would
 * fail enum casting and turn a mistyped bookmark into a 500.
 */
export function isRequestStatus(value: string | undefined): value is VizservePmsRequestStatus {
  return typeof value === "string" && value in REQUEST_STATUS;
}

/**
 * Task statuses (P3).
 *
 * Labels come from `lib/schemas/tasks.ts` rather than being restated here — that
 * module is the contract both tracks import, and a second copy of
 * "COMPLETED_NO_RESPONSE reads as Completed (no response)" is a second place for
 * it to drift.
 *
 * The two terminal states are styled DIFFERENTLY on purpose. `COMPLETED` means
 * the client approved; `COMPLETED_NO_RESPONSE` means the clock ran out and
 * nobody looked. Phase 6 reports the split, and a queue that renders them
 * identically hides the thing worth reporting.
 */
const TASK_STATUS_CLASSES: Record<VizservePmsTaskStatus, string> = {
  OPEN: "bg-muted text-muted-foreground",
  ONGOING: "bg-info-subtle text-info",
  WAITING_FOR_INFO: "bg-warning-subtle text-warning",
  // The two QA states use the brand tint (`--accent` / `--accent-foreground`),
  // not `--secondary`. Secondary is a near-white neutral, so a 25% wash of it
  // was an invisible pill on a white card — the label carried the state and the
  // fill did nothing. `--accent` is #EEF1F9 with brand text at 5.79:1, and it
  // flips correctly in dark mode.
  FOR_QA: "bg-accent text-accent-foreground",
  QA_IN_PROGRESS: "bg-accent text-accent-foreground",
  FOR_CLIENT_APPROVAL: "bg-warning-subtle text-warning",
  COMPLETED: "bg-success-subtle text-success",
  COMPLETED_NO_RESPONSE: "bg-muted text-muted-foreground",
};

export function TaskStatusBadge({
  status,
  className,
}: {
  status: VizservePmsTaskStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap",
        TASK_STATUS_CLASSES[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {TASK_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export const TASK_STATUS_OPTIONS = (
  Object.keys(TASK_STATUS_CLASSES) as VizservePmsTaskStatus[]
).map((value) => ({ value, label: TASK_STATUS_LABELS[value] }));

export function isTaskStatus(value: string | undefined): value is VizservePmsTaskStatus {
  return typeof value === "string" && value in TASK_STATUS_CLASSES;
}

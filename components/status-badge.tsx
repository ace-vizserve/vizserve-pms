import { cn } from "@/lib/utils";
import type { VizservePmsRequestStatus } from "@/lib/database.types";

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

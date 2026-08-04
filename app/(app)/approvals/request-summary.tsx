import { formatDate, formatDateTime } from "@/lib/dates";
import type { InternalRequestRow } from "@/lib/database.types";
import { INTERNAL_REQUEST_LABELS } from "@/lib/schemas/internal-requests";

/**
 * The one-line "what is being asked for", shared by the list and the detail
 * page so the two cannot describe the same request differently.
 */
export function requestDetail(request: InternalRequestRow): string {
  switch (request.request_type) {
    case "LEAVE":
      return request.start_date === request.end_date
        ? formatDate(request.start_date)
        : `${formatDate(request.start_date)} → ${formatDate(request.end_date)}`;
    case "REIMBURSEMENT":
      // Grouped and 2dp, because an unformatted 1250.5 in a money column is
      // read wrong at a glance.
      return `₱${Number(request.amount ?? 0).toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    default:
      return `${formatDate(request.work_date)} at ${formatDateTime(request.correction_at).split(", ")[1] ?? "—"}`;
  }
}

const STATUS_STYLES: Record<string, string> = {
  PENDING_REVIEW: "bg-warning-subtle text-warning",
  APPROVED: "bg-success-subtle text-success",
  REJECTED: "bg-destructive/10 text-destructive",
};

/**
 * Status pill. Carries its label always — state is never conveyed by colour
 * alone, so this stays readable in greyscale and in a printed queue.
 */
export function InternalStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {status === "PENDING_REVIEW" ? "Pending" : status === "APPROVED" ? "Approved" : "Rejected"}
    </span>
  );
}

export function TypeBadge({ type }: { type: InternalRequestRow["request_type"] }) {
  return (
    <span className="inline-flex shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
      {INTERNAL_REQUEST_LABELS[type]}
    </span>
  );
}

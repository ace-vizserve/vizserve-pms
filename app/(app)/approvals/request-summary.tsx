import { formatDate, formatDateTime } from "@/lib/dates";
import type { InternalRequestRow } from "@/lib/database.types";

/**
 * The one-line "what is being asked for", shared by the list and the detail
 * page so the two cannot describe the same request differently.
 *
 * The status and type pills that used to live here have moved to
 * `components/status-badge.tsx`. They were a second badge system for the same
 * idea, already drifted a font weight away from the first.
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

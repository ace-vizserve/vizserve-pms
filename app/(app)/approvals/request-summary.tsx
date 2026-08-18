import { formatDate, formatDateTime } from "@/lib/dates";
import { describeLeaveSpan } from "@/lib/schemas/internal-requests";
import { formatCellDuration } from "@/lib/schemas/timesheet";
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
      // P7-16. One shared description, because the dialog, the queue and the
      // detail all have to say the same thing — three copies of "when is this
      // person away" is three chances to disagree about a half day.
      //
      // An en dash, not an arrow. This is a SPAN — the 5th to the 7th — and an
      // arrow claims a direction of travel it does not have.
      return describeLeaveSpan(
        request.start_date!,
        request.end_date!,
        request.start_half,
        request.end_half,
        formatDate,
      );
    case "REIMBURSEMENT":
      // Grouped and 2dp, because an unformatted 1250.5 in a money column is
      // read wrong at a glance.
      return `₱${Number(request.amount ?? 0).toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    case "OVERTIME":
      // Was falling through to the correction branch, which reads
      // `correction_at` — null on every overtime row — and rendered every one of
      // them as "18 Aug at —".
      return `${formatDate(request.work_date)} · ${formatCellDuration(request.overtime_minutes ?? 0)}`;
    case "NO_TIME_IN":
    case "NO_TIME_OUT":
      return `${formatDate(request.work_date)} at ${formatDateTime(request.correction_at).split(", ")[1] ?? "—"}`;
    default: {
      /**
       * The `default:` this replaces is why overtime mis-rendered for a while:
       * a new type fell into the correction branch and produced a plausible,
       * wrong sentence instead of failing.
       *
       * Assigning to `never` makes the next added type a COMPILE error here
       * rather than a quiet mis-render. Do not turn this back into a fallback.
       */
      const exhaustive: never = request.request_type;
      return exhaustive;
    }
  }
}

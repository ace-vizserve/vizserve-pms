import Link from "next/link";

import { formatDuration } from "@/lib/dates";
import type { OvertimeApproval } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

/**
 * P8-08 — the way from a flagged day to the overtime that authorised it.
 *
 * WHY THIS EXISTS. Both timesheet grids mark a long day "OT" or "over +1h", and
 * that marker is an assertion about a decision a named person made: they
 * approved these hours, for this long, on this date. There was no way to reach
 * that decision from the day it changed — a member could not check what they had
 * been granted, and a lead reviewing a week could not see who had signed off on
 * somebody's eleven-hour Tuesday. A marker nobody can audit is one people learn
 * to ignore, and the marker is the whole of what this rule has.
 *
 * ⚠️ ONE LINK PER APPROVAL, NEVER ONE LINK PER DAY. There is deliberately no
 * unique constraint on (requester, work_date, OVERTIME) — two approvals for one
 * day is a legitimate thing that happened, and both grids already SUM them.
 * Picking one of the two to link to would hide a signature; linking "the day"
 * is not on offer either, because `/approvals` has no per-day view and inventing
 * one for a marker would be a lot of surface for a rare case. So each approval
 * is listed with the minutes IT granted, which is also the only rendering that
 * explains why a day's capacity is eleven hours rather than nine.
 *
 * ⚠️ THE MARKER ITSELF IS NOT THE LINK, even in the common one-approval case.
 * The marker is a statement about the whole day (`over +1h` is arithmetic across
 * every entry on it); a link on it would claim one request accounts for the day.
 * They stay separate, and the marker keeps its colour-plus-words treatment.
 *
 * ⚠️ EVERY ID HERE CAME FROM A POLICY-SCOPED READ, and that is the only reason
 * these links are safe to offer. `vizserve_pms_internal_requests` is readable on
 * `requester_id = auth.uid() or manages_department(department_id)`, so a request
 * that arrived in the page's query result is one this viewer may open. On the
 * lead's grid the corollary is the important half: a lead who cannot read
 * somebody's overtime request simply gets no row for it, and therefore no link
 * to a page that would refuse them.
 */
export function OvertimeApprovalLinks({
  approvals,
  className,
}: {
  approvals: readonly OvertimeApproval[] | undefined;
  className?: string;
}) {
  const list = approvals ?? [];
  if (list.length === 0) return null;

  return (
    <span className={cn("mt-0.5 flex flex-wrap justify-center gap-x-1 gap-y-0.5 leading-none", className)}>
      {list.map((approval, index) => (
        <Link
          key={approval.id}
          href={`/approvals/${approval.id}`}
          /* Underlined rather than tinted. The cell around it is already amber or
             red for a reason of its own, and a link that borrowed either colour
             would be leaving "this is a link" to the colour — which is the one
             thing nothing in this app does. */
          className="text-2xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline">
          +{formatDuration(approval.minutes)}
          {/* "+2h" is not a readable link name. The sentence is, and it says
              which of several approvals this one is — the reason the list is a
              list. */}
          <span className="sr-only">
            {" "}
            approved overtime
            {list.length > 1 ? `, request ${index + 1} of ${list.length}` : ""}. Open the request.
          </span>
        </Link>
      ))}
    </span>
  );
}

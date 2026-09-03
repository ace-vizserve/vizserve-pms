"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
import { TimesheetWeekBadge } from "@/components/status-badge";
import { formatDate, formatWeekRange, relativeDays } from "@/lib/dates";
import { formatCellDuration } from "@/lib/schemas/timesheet";
/* TYPE ONLY. `approvals-queue-server` takes a Supabase client as an argument and
   imports nothing server-only, but the name says where it runs — a type import
   is erased, so this borrows the shape without pulling the module into the
   browser bundle. Borrowing it rather than restating it is the point: the row
   this table draws is the row that function defines. */
import type { PendingWeek } from "@/lib/approvals-queue-server";

/**
 * P8 — the third approval queue, on the page that only ever showed two.
 *
 * ⚠️ THIS TABLE DOES NOT DECIDE ANYTHING, and every column is written to say so.
 * `vizserve_pms_decide_timesheet_week` is reachable from the team week grid and
 * nowhere else, because a week approved from a list is a week approved without
 * anybody looking at the hours in it. So these rows are SIGNPOSTS: they carry
 * enough to triage — who, which week, how much, how long it has sat — and then
 * hand over to the grid.
 *
 * The row must therefore not look like the internal-request rows above it, which
 * DO open a detail page with approve and reject on it. Three things separate
 * them, none of them colour:
 *
 *   1. its own section, with its own heading saying where the link goes,
 *   2. an arrow glyph and the words "Team week grid" under every week link,
 *   3. the week's own status vocabulary — "Submitted", never "Awaiting review".
 *
 * ⚠️ THE VOCABULARIES STAY APART (D23). An internal request is
 * PENDING_REVIEW / APPROVED / REJECTED and can never be returned; a week is
 * SUBMITTED / RETURNED / APPROVED and can never be rejected, because hours
 * already worked cannot be un-worked. `TimesheetWeekBadge` is the week's half of
 * that and `InternalStatusBadge` is the request's; merging them into one map
 * would invent statuses neither table can reach.
 */

/*
 * ⚠️ NO `sortKey` ON ANY COLUMN, AND NO `urlSort`.
 *
 * `?sort=` on this page belongs to the internal-request table — the server maps
 * it to `request_type` / `created_at` / `status` / `reviewed_at`, none of which
 * a timesheet week has. A second sortable table sharing that one parameter would
 * reorder the other list every time somebody clicked a heading here. The rows
 * arrive oldest-first from Postgres, which is the order a queue is worked in.
 */
const COLUMNS: Column<PendingWeek>[] = [
  {
    key: "week",
    header: "Week",
    cell: (week) => (
      <>
        <Link href={week.href} className="inline-flex items-center gap-1 font-medium hover:underline">
          {formatWeekRange(week.weekStart)}
          <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
        </Link>
        {/* Says where the click goes BEFORE it happens. The rows above this
            table open /approvals/<id>; this one leaves the queue entirely. */}
        <div className="text-2xs text-muted-foreground">Team week grid</div>
      </>
    ),
  },
  {
    key: "who",
    header: "From",
    cell: (week) => week.name ?? "A colleague",
  },
  {
    key: "total",
    header: "Handed in",
    align: "end",
    className: "whitespace-nowrap tabular-nums",
    /* What they ATTESTED TO. The grid shows live entries and will say so where
       the two differ — this figure is the one they signed off, and quietly
       showing a recomputed total here would make the two screens disagree. */
    cell: (week) => formatCellDuration(week.submittedMinutes),
  },
  {
    key: "waiting",
    header: "Waiting",
    className: "hidden sm:table-cell whitespace-nowrap text-muted-foreground",
    /* Relative, with the date underneath: "4 days ago" is the fact a lead acts
       on, and the absolute date is what they quote when they chase it. */
    cell: (week) => (
      <>
        <div>{relativeDays(week.submittedAt.slice(0, 10))}</div>
        <div className="text-2xs">{formatDate(week.submittedAt)}</div>
      </>
    ),
  },
  {
    key: "status",
    header: "Status",
    /* The WEEK's badge, not `InternalStatusBadge`. Both would render a pill here
       and only one of them can say "Submitted" — see the note on the vocabularies
       above. */
    cell: (week) => <TimesheetWeekBadge status={week.status} />,
  },
];

export function TimesheetWeeksSection({
  rows,
  empty,
}: {
  rows: PendingWeek[];
  /** The failure state. A week queue that renders empty on a failed read is the
      worst tie on this page — see `components/query-error.tsx`. */
  empty: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(week) => week.id}
        toolbar={
          <div>
            <h2 className="text-sm font-semibold">Timesheet weeks handed in</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Approving or sending a week back happens on the team week grid, beside the hours it is
              made of. These rows open it on the right week.
            </p>
          </div>
        }
        count={
          <>
            <span className="tabular-nums">{rows.length}</span> {rows.length === 1 ? "week" : "weeks"}
          </>
        }
        empty={empty}
      />
    </section>
  );
}

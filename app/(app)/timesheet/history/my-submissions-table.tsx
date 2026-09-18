"use client";

import Link from "next/link";
import { CalendarCheck } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { TimesheetWeekBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import type { VizservePmsTimesheetWeekStatus } from "@/lib/database.types";
import { formatDate, formatWeekRange } from "@/lib/dates";
import { formatCellDuration } from "@/lib/schemas/timesheet";

export type MySubmission = {
  id: string;
  weekStart: string;
  status: VizservePmsTimesheetWeekStatus;
  submittedMinutes: number;
  submittedAt: string;
  decisionReason: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
};

const COLUMNS: Column<MySubmission>[] = [
  {
    key: "week",
    header: "Week",
    sortKey: "week",
    sortValue: (week) => week.weekStart,
    cell: (week) => (
      <Link href={`/timesheet?week=${week.weekStart}`} className="font-medium hover:underline">
        {formatWeekRange(week.weekStart)}
      </Link>
    ),
  },
  {
    key: "total",
    header: "Handed in",
    sortKey: "total",
    sortValue: (week) => week.submittedMinutes,
    align: "end",
    className: "whitespace-nowrap tabular-nums",
    // What was attested to at submission — the grid shows live entries.
    cell: (week) => formatCellDuration(week.submittedMinutes),
  },
  {
    key: "submitted",
    header: "Submitted",
    className: "hidden sm:table-cell whitespace-nowrap text-muted-foreground",
    cell: (week) => formatDate(week.submittedAt),
  },
  {
    key: "status",
    header: "Status",
    cell: (week) => <TimesheetWeekBadge status={week.status} />,
  },
  {
    key: "decided",
    header: "Decided",
    className: "hidden md:table-cell whitespace-nowrap text-muted-foreground",
    cell: (week) =>
      week.reviewedAt ? (
        <>
          <div>{formatDate(week.reviewedAt)}</div>
          {week.reviewerName ? <div className="text-2xs">{week.reviewerName}</div> : null}
        </>
      ) : (
        "—"
      ),
  },
  {
    key: "note",
    header: "Note",
    className: "max-w-xs text-muted-foreground",
    cell: (week) =>
      week.decisionReason ? <span className="line-clamp-2">{week.decisionReason}</span> : "—",
  },
];

export function MySubmissionsTable({
  rows,
  error,
}: {
  rows: MySubmission[];
  /** A failed read, rendered in place of the empty state so it cannot pass for one. */
  error: React.ReactNode;
}) {
  const returned = rows.filter((week) => week.status === "RETURNED").length;

  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(week) => week.id}
      defaultSort={{ key: "week", dir: "desc" }}
      toolbar={
        <div>
          <h2 className="text-sm font-semibold">My submitted weeks</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {returned > 0
              ? `${returned} ${returned === 1 ? "week was" : "weeks were"} sent back — open ${returned === 1 ? "it" : "them"} to fix and resubmit.`
              : "Every week you have handed in and what happened to it. Open a week to see its hours."}
          </p>
        </div>
      }
      count={
        <>
          <span className="tabular-nums">{rows.length}</span> {rows.length === 1 ? "week" : "weeks"}
        </>
      }
      empty={
        error ?? (
          <EmptyState
            icon={<CalendarCheck />}
            title="No weeks handed in yet"
            description="Submit a week from your timesheet and it will appear here with its status."
            action={
              <Link href="/timesheet" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Go to my week
              </Link>
            }
          />
        )
      }
    />
  );
}

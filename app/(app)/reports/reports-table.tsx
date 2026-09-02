"use client";

import { BarChart3 } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/schemas/tasks";
import { formatCellDuration } from "@/lib/schemas/timesheet";

/**
 * P7-64 — the columns, in a client component, because the table is one now.
 *
 * `cell` is a function and a function cannot cross the RSC boundary. The server
 * page keeps the queries and the aggregation; this file draws the rows.
 *
 * ⚠️ NO `urlSort`. Every department in scope is already in `rows` — the page
 * aggregates the whole period before rendering — so sorting in the browser
 * reorders the complete table and is honest. This is the report where sorting
 * by "Overdue" is the obvious first thing somebody wants, and it works without
 * a round trip.
 */

export type ReportRow = {
  id: string;
  name: string;
  byStatus: Record<VizservePmsTaskStatus, number>;
  notStarted: number;
  active: number;
  done: number;
  overdue: number;
  minutes: number;
  total: number;
};

export function ReportsTable({ rows }: { rows: ReportRow[] }) {

  const columns: Column<ReportRow>[] = [
    {
      key: "department",
      header: "Department",
      sortKey: "department",
      sortValue: (row) => row.name,
      /* Eight status columns plus the totals scroll sideways on any real screen;
         the department name is what makes a row identifiable while they do. */
      pin: "left",
      className: "font-medium",
      cell: (row) => row.name,
    },
    ...TASK_STATUSES.map(
      (status): Column<ReportRow> => ({
        key: status,
        // The human label, never the enum — a column headed
        // "COMPLETED_NO_RESPONSE" is a database value on screen.
        header: TASK_STATUS_LABELS[status],
        /* Sortable, because "who has the most work sitting in QA" is the
           question this report exists to answer and it was only answerable by
           reading down a column by eye. The key is the status itself, which is
           already unique. */
        sortKey: status,
        hideable: true,
        // The count lives under `byStatus`, not on the row itself.
        sortValue: (row) => row.byStatus[status],
        className: "hidden lg:table-cell tabular-nums text-muted-foreground",
        align: "end",
        cell: (row) =>
          row.byStatus[status] === 0 ? (
            // A dash rather than a zero. Eight columns of zeroes is a table
            // nobody can find the numbers in.
            <span className="text-foreground-faint">—</span>
          ) : (
            row.byStatus[status]
          ),
      }),
    ),
    {
      /*
       * P7-66 — `total` and `done` were computed on every row and printed
       * nowhere. The eight per-status columns are the breakdown; without a
       * total beside them a reader has to add eight numbers to answer "how much
       * work does this department have", which is the first question the report
       * is opened for.
       */
      key: "total",
      header: "Total",
      hideable: true,
      defaultHidden: true,
      sortKey: "total",
      className: "tabular-nums",
      align: "end",
      cell: (row) =>
        row.total === 0 ? <span className="text-foreground-faint">—</span> : row.total,
    },
    {
      key: "completion",
      header: "Done",
      hideable: true,
      defaultHidden: true,
      sortKey: "completion",
      // Rank by the PERCENTAGE, which is the number on screen — sorting by the
      // raw `done` count would order the column by something it does not show.
      sortValue: (row) => (row.total === 0 ? -1 : row.done / row.total),
      className: "tabular-nums",
      align: "end",
      /*
       * A PERCENTAGE, because the counts are not comparable between departments
       * of different sizes — 12 done means one thing against 15 and another
       * against 200.
       *
       * ⚠️ Guarded on `total`, not just rendered: a department with no work in
       * the period would otherwise read `NaN%`.
       */
      cell: (row) =>
        row.total === 0 ? (
          <span className="text-foreground-faint">—</span>
        ) : (
          <span title={`${row.done} of ${row.total} completed`}>
            {Math.round((row.done / row.total) * 100)}%
          </span>
        ),
    },
    {
      key: "overdue",
      hideable: true,
      header: "Overdue",
      sortKey: "overdue",
      className: "tabular-nums",
      align: "end",
      cell: (row) =>
        row.overdue === 0 ? (
          <span className="text-foreground-faint">—</span>
        ) : (
          // The word travels with the number, so a scanned column does not rely
          // on the heading being in view.
          <span className="font-medium text-destructive">{row.overdue} late</span>
        ),
    },
    {
      key: "hours",
      hideable: true,
      header: "Logged",
      sortKey: "hours",
      className: "tabular-nums",
      align: "end",
      cell: (row) =>
        row.minutes === 0 ? (
          <span className="text-foreground-faint">—</span>
        ) : (
          formatCellDuration(row.minutes)
        ),
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("reports", columns);

  return (
    <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      empty={
        <EmptyState
          icon={<BarChart3 />}
          title="Nothing in this period"
          description="No tasks were created between these two dates. Widen the range, or check that the department you expected has work in it."
        />
      }
      />
  );
}

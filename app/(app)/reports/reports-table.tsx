"use client";

import { BarChart3 } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
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
      className: "font-medium",
      cell: (row) => row.name,
    },
    ...TASK_STATUSES.map(
      (status): Column<ReportRow> => ({
        key: status,
        // The human label, never the enum — a column headed
        // "COMPLETED_NO_RESPONSE" is a database value on screen.
        header: TASK_STATUS_LABELS[status],
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
      key: "overdue",
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

  return (
    <DataTable
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

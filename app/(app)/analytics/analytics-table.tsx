"use client";

import { ChartPie } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import type { WorkloadRow } from "@/lib/department-analytics";

import { Monogram } from "../tasks/assignees";

/**
 * P11-14 — the per-person table. A client component for the same reason
 * `reports-table.tsx` is one: `cell` is a function and cannot cross the RSC
 * boundary.
 *
 * No `urlSort`: the page aggregates every task in scope before rendering, so
 * sorting in the browser reorders the complete table.
 */

export type AnalyticsRow = WorkloadRow & { departmentName: string | null };

/** A dash rather than a zero — a column of zeroes hides the numbers in it. */
const NONE = <span className="text-foreground-faint">—</span>;

function count(value: number) {
  return value === 0 ? NONE : value;
}

export function AnalyticsTable({ rows }: { rows: AnalyticsRow[] }) {
  const columns: Column<AnalyticsRow>[] = [
    {
      key: "person",
      header: "Person",
      sortKey: "person",
      sortValue: (row) => row.name,
      pin: "left",
      className: "min-w-56 whitespace-normal",
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Monogram id={row.id} name={row.name} />
          <span className="min-w-0">
            <span className="block font-medium">{row.name}</span>
            {row.departmentName ? (
              <span className="block text-2xs text-muted-foreground">{row.departmentName}</span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: "total",
      header: "Tasks",
      sortKey: "total",
      className: "tabular-nums font-medium",
      align: "end",
      cell: (row) => count(row.total),
    },
    {
      key: "notStarted",
      header: "Not started",
      hideable: true,
      sortKey: "notStarted",
      className: "hidden md:table-cell tabular-nums text-muted-foreground",
      align: "end",
      cell: (row) => count(row.notStarted),
    },
    {
      key: "active",
      header: "In progress",
      hideable: true,
      sortKey: "active",
      className: "hidden md:table-cell tabular-nums text-muted-foreground",
      align: "end",
      cell: (row) => count(row.active),
    },
    {
      key: "completed",
      header: "Completed",
      sortKey: "completed",
      className: "tabular-nums",
      align: "end",
      cell: (row) => count(row.completed),
    },
    {
      key: "completion",
      header: "Done",
      hideable: true,
      sortKey: "completion",
      // Rank by the percentage on screen, not the raw completed count.
      sortValue: (row) => (row.total === 0 ? -1 : row.completed / row.total),
      className: "tabular-nums",
      align: "end",
      // ⚠️ Guarded on `total`: a person with no tasks would otherwise read NaN%.
      cell: (row) =>
        row.total === 0 ? (
          NONE
        ) : (
          <span title={`${row.completed} of ${row.total} completed`}>
            {Math.round((row.completed / row.total) * 100)}%
          </span>
        ),
    },
    {
      key: "overdue",
      header: "Overdue",
      hideable: true,
      sortKey: "overdue",
      className: "tabular-nums",
      align: "end",
      cell: (row) =>
        row.overdue === 0 ? (
          NONE
        ) : (
          // The word travels with the number, so colour is never the only signal.
          <span className="font-medium text-destructive">{row.overdue} late</span>
        ),
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("analytics", columns);

  return (
    <DataTable
      columnVisibility={visibility}
      onColumnVisibilityChange={onVisibilityChange}
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      empty={
        <EmptyState
          icon={<ChartPie />}
          title="Nobody in this department yet"
          description="There are no active people in the department you picked, and no tasks with anybody on them. Pick another department, or add people from Users."
        />
      }
    />
  );
}

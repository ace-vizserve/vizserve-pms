"use client";

import Link from "next/link";
import { CalendarOff } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { InternalStatusBadge } from "@/components/status-badge";
import type { VizservePmsInternalRequestStatus } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";

export type MyLeaveRow = {
  id: string;
  status: VizservePmsInternalRequestStatus;
  typeLabel: string;
  /** Pre-rendered on the server by `describeLeaveSpan`, the one shared wording. */
  when: string;
  startDate: string;
  filedAt: string;
};

const COLUMNS: Column<MyLeaveRow>[] = [
  {
    key: "when",
    header: "When",
    sortKey: "when",
    sortValue: (row) => row.startDate,
    cell: (row) => (
      <Link href={`/approvals/${row.id}`} className="font-medium hover:underline">
        {row.when}
      </Link>
    ),
  },
  {
    key: "type",
    header: "Type",
    sortKey: "type",
    sortValue: (row) => row.typeLabel,
    cell: (row) => row.typeLabel,
  },
  {
    key: "filed",
    header: "Filed",
    className: "hidden sm:table-cell whitespace-nowrap text-muted-foreground",
    cell: (row) => formatDate(row.filedAt),
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => <InternalStatusBadge status={row.status} />,
  },
];

export function MyLeaveTable({
  year,
  rows,
  error,
}: {
  year: number;
  rows: MyLeaveRow[];
  /** A failed read, rendered in place of the empty state so it cannot pass for one. */
  error: React.ReactNode;
}) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(row) => row.id}
      defaultSort={{ key: "when", dir: "desc" }}
      toolbar={
        <div>
          <h2 className="text-sm font-semibold">Leave requests · {year}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Everything you filed that starts in {year}. Only approved leave counts against a balance.
          </p>
        </div>
      }
      count={
        <>
          <span className="tabular-nums">{rows.length}</span>{" "}
          {rows.length === 1 ? "request" : "requests"}
        </>
      }
      empty={
        error ?? (
          <EmptyState
            icon={<CalendarOff />}
            title={`No leave filed for ${year}`}
            description="File leave from Approvals and it will appear here with its status."
          />
        )
      }
    />
  );
}

"use client";

import Link from "next/link";
import { Users } from "lucide-react";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * P15-02 — one row per person, every measure a column, the department average
 * as the last row so each number has something to be read against. Plain
 * numbers cross the server boundary; formatting happens here.
 */
export type PersonRow = {
  id: string;
  name: string;
  department: string | null;
  open: number;
  overdue: number;
  completed: number;
  /** Percent, or null when nothing was measurable. Paired with its denominator. */
  onTime: number | null;
  onTimeOf: number;
  cycleDays: number | null;
  firstPass: number | null;
  firstPassOf: number;
  qaReturns: number;
  reviews: number;
  minutes: number;
  accounted: number | null;
  timesheetsOnTime: number | null;
  timesheetsExpected: number;
  missingTimesheets: number;
  late: number | null;
  absent: number | null;
  rating: number | null;
  ratingCount: number;
};

export type AverageRow = Omit<PersonRow, "id" | "name" | "department" | "onTimeOf" | "firstPassOf" | "timesheetsExpected" | "ratingCount">;

const dash = <span className="text-foreground-faint">—</span>;
const num = (value: number | null, digits = 0) => (value === null ? dash : value.toFixed(digits));
const pctCell = (value: number | null, of?: number) =>
  value === null ? dash : (
    <span title={of !== undefined ? `out of ${of}` : undefined}>{Math.round(value)}%</span>
  );
const hoursCell = (minutes: number | null) => (minutes === null ? dash : `${(minutes / 60).toFixed(1)}h`);

/** Worse than the department average by a clear margin — said with a word, not colour alone. */
function flag(value: number | null, average: number | null | undefined, better: "up" | "down") {
  if (value === null || average === null || average === undefined) return false;
  const margin = Math.max(1, Math.abs(average) * 0.25);
  return better === "up" ? value < average - margin : value > average + margin;
}

export function PeopleTable({ rows, average }: { rows: PersonRow[]; average: AverageRow }) {
  const watch = (content: React.ReactNode, isFlagged: boolean) =>
    isFlagged ? (
      <span className="font-medium text-warning" title="Clearly worse than the department average">
        {content} <span className="sr-only">(below the department average)</span>▾
      </span>
    ) : (
      content
    );

  const columns: Column<PersonRow>[] = [
    {
      key: "person",
      header: "Person",
      sortKey: "person",
      sortValue: (row) => row.name,
      pin: "left",
      className: "min-w-48 whitespace-normal",
      cell: (row) => (
        <span className="min-w-0">
          <Link href={`/analytics/people/${row.id}`} className="block font-medium hover:underline">
            {row.name}
          </Link>
          {row.department ? <span className="block text-2xs text-muted-foreground">{row.department}</span> : null}
        </span>
      ),
    },
    { key: "open", header: "Open", sortKey: "open", sortValue: (row) => row.open, align: "end", className: "tabular-nums", cell: (row) => row.open },
    {
      key: "overdue",
      header: "Overdue",
      sortKey: "overdue",
      sortValue: (row) => row.overdue,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(row.overdue, flag(row.overdue, average.overdue, "down")),
    },
    { key: "completed", header: "Done", sortKey: "completed", sortValue: (row) => row.completed, align: "end", className: "tabular-nums", cell: (row) => row.completed },
    {
      key: "onTime",
      header: "On time",
      sortKey: "onTime",
      sortValue: (row) => row.onTime ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(pctCell(row.onTime, row.onTimeOf), flag(row.onTime, average.onTime, "up")),
    },
    {
      key: "cycle",
      header: "Cycle (days)",
      sortKey: "cycle",
      sortValue: (row) => row.cycleDays ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(num(row.cycleDays, 1), flag(row.cycleDays, average.cycleDays, "down")),
    },
    {
      key: "firstPass",
      header: "QA first pass",
      sortKey: "firstPass",
      sortValue: (row) => row.firstPass ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(pctCell(row.firstPass, row.firstPassOf), flag(row.firstPass, average.firstPass, "up")),
    },
    { key: "qaReturns", header: "QA returns", sortKey: "qaReturns", sortValue: (row) => row.qaReturns, align: "end", className: "tabular-nums", cell: (row) => row.qaReturns },
    { key: "reviews", header: "Reviews done", sortKey: "reviews", sortValue: (row) => row.reviews, align: "end", className: "tabular-nums", cell: (row) => row.reviews },
    { key: "hours", header: "Hours", sortKey: "hours", sortValue: (row) => row.minutes, align: "end", className: "tabular-nums", cell: (row) => hoursCell(row.minutes) },
    {
      key: "accounted",
      header: "Clocked time logged",
      sortKey: "accounted",
      sortValue: (row) => row.accounted ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(pctCell(row.accounted), flag(row.accounted, average.accounted, "up")),
    },
    {
      key: "timesheets",
      header: "Timesheets on time",
      sortKey: "timesheets",
      sortValue: (row) => row.timesheetsOnTime ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => (
        <span>
          {watch(pctCell(row.timesheetsOnTime, row.timesheetsExpected), flag(row.timesheetsOnTime, average.timesheetsOnTime, "up"))}
          {row.missingTimesheets > 0 ? (
            <span className="block text-2xs text-warning">{row.missingTimesheets} missing</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "late",
      header: "Late",
      sortKey: "late",
      sortValue: (row) => row.late ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(num(row.late), flag(row.late, average.late, "down")),
    },
    {
      key: "absent",
      header: "Absent",
      sortKey: "absent",
      sortValue: (row) => row.absent ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) => watch(num(row.absent, row.absent !== null && row.absent % 1 !== 0 ? 1 : 0), flag(row.absent, average.absent, "down")),
    },
    {
      key: "rating",
      header: "Rating",
      sortKey: "rating",
      sortValue: (row) => row.rating ?? -1,
      align: "end",
      className: "tabular-nums",
      cell: (row) =>
        row.rating === null ? dash : (
          <span title={`${row.ratingCount} ${row.ratingCount === 1 ? "rating" : "ratings"}`}>{row.rating.toFixed(1)}</span>
        ),
    },
  ];

  const footerCells: React.ReactNode[] = [
    "Department average",
    num(average.open, 1),
    num(average.overdue, 1),
    num(average.completed, 1),
    pctCell(average.onTime),
    num(average.cycleDays, 1),
    pctCell(average.firstPass),
    num(average.qaReturns, 1),
    num(average.reviews, 1),
    hoursCell(average.minutes),
    pctCell(average.accounted),
    pctCell(average.timesheetsOnTime),
    num(average.late, 1),
    num(average.absent, 1),
    num(average.rating, 1),
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      defaultSort={{ key: "person", dir: "asc" }}
      empty={<EmptyState icon={<Users />} title="Nobody in scope" description="There is nobody in the departments you can see." />}
      footer={
        <TableRow>
          {footerCells.map((cell, index) => (
            <TableCell
              key={index}
              className={cn("text-xs font-medium text-muted-foreground tabular-nums", index > 0 && "text-right")}
            >
              {cell}
            </TableCell>
          ))}
        </TableRow>
      }
    />
  );
}

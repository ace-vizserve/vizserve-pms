"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import type { AttendanceSummary } from "@/lib/attendance-summary";

/** `2026-03` → `March 2026`, from the parts rather than through `Date`. */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${MONTH_NAMES[monthNumber - 1] ?? month} ${year}`;
}

/** `2026-03` shifted by n months, without leaving string arithmetic. */
function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const zeroBased = year * 12 + (monthNumber - 1) + delta;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

export function AttendanceTable({
  month,
  thisMonth,
  summaries,
}: {
  month: string;
  thisMonth: string;
  summaries: AttendanceSummary[];
}) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? summaries.filter(
          (row) =>
            row.fullName.toLowerCase().includes(needle) ||
            (row.departmentName ?? "").toLowerCase().includes(needle),
        )
      : summaries;

    // Sorted by what HR opened the page to find: unexplained absence first,
    // then repeated lateness. Alphabetical would bury the two rows that matter
    // among thirty that do not.
    return [...filtered].sort(
      (a, b) => b.absent - a.absent || b.late - a.late || a.fullName.localeCompare(b.fullName),
    );
  }, [summaries, query]);

  /*
   * P7-66 — THE COUNTS ARE NOT COMPARABLE BETWEEN PEOPLE.
   *
   * Somebody with 4 absences out of 8 working days and somebody with 4 out of
   * 22 read identically in the Absent column, and this table exists to be
   * scanned down. The rate is the figure that makes a row mean something on its
   * own.
   *
   * ⚠️ `unscheduled` rather than a division guard. It is true exactly when every
   * count is zero because no schedule is recorded, which is a different fact
   * from "present on none of their days" — and dividing would print `NaN%` for
   * it.
   */
  function attendanceRate(row: AttendanceSummary): number | null {
    if (row.unscheduled || row.workingDays === 0) return null;
    return Math.round((row.present / row.workingDays) * 100);
  }

  const columns: Column<AttendanceSummary>[] = [
    {
      key: "person",
      sortKey: "person",
      // ⚠️ THE FIELD IS `fullName`, not `person` — without this the default
      // accessor returns `undefined` for every row and the only alphabetical
      // control on the page does nothing.
      sortValue: (row) => row.fullName,
      header: "Employee",
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.fullName}</span>
          <span className="text-[11px] text-muted-foreground">
            {row.departmentName ?? "No department"}
          </span>
        </div>
      ),
    },
    {
      key: "workingDays",
      sortKey: "workingDays",
      hideable: true,
      header: "Working days",
      align: "end",
      cell: (row) => <span className="tabular-nums">{row.workingDays}</span>,
    },
    {
      key: "present",
      sortKey: "present",
      header: "Present",
      align: "end",
      cell: (row) =>
        // Nothing is counted for somebody with no schedule, and saying so in the
        // row is the point — a line of zeroes would read as perfect attendance.
        row.unscheduled ? (
          <Badge variant="outline">No fixed hours</Badge>
        ) : (
          <span className="tabular-nums">{row.present}</span>
        ),
    },
    {
      key: "onLeave",
      sortKey: "onLeave",
      hideable: true,
      header: "On leave",
      align: "end",
      cell: (row) => <span className="tabular-nums">{row.unscheduled ? "—" : row.onLeave}</span>,
    },
    {
      key: "absent",
      sortKey: "absent",
      header: "Absent",
      align: "end",
      cell: (row) =>
        row.unscheduled ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          // The label carries it, never the weight alone — this is read in
          // black and white as often as on screen.
          <span className={`tabular-nums ${row.absent > 0 ? "font-semibold" : ""}`}>
            {row.absent}
          </span>
        ),
    },
    {
      key: "late",
      sortKey: "late",
      header: "Late",
      align: "end",
      cell: (row) =>
        row.unscheduled ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col items-end">
            <span className="tabular-nums">{row.late}</span>
            {/* How OFTEN and how BADLY are different questions, and a count of
                five one-minute lates reads very differently from five
                forty-minute ones. */}
            {row.lateMinutes > 0 ? (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {row.lateMinutes}m total
              </span>
            ) : null}
          </div>
        ),
    },
    {
      key: "undertime",
      sortKey: "undertime",
      header: "Undertime",
      align: "end",
      cell: (row) => <span className="tabular-nums">{row.unscheduled ? "—" : row.undertime}</span>,
    },
    {
      key: "rate",
      header: "Rate",
      sortKey: "rate",
      // Unscheduled people have no rate; -1 sinks them rather than tying at 0%
      // with somebody who genuinely attended none of their days.
      sortValue: (row) => attendanceRate(row) ?? -1,
      hideable: true,
      defaultHidden: true,
      align: "end",
      className: "hidden lg:table-cell tabular-nums",
      cell: (row) => {
        const rate = attendanceRate(row);
        if (rate === null) return <span className="text-foreground-faint">—</span>;

        // Never colour alone: the number is the carrier and the tone is a
        // second reading of it, so greyscale loses nothing.
        return (
          <span
            className={rate < 80 ? "font-medium text-warning" : undefined}
            title={`${row.present} of ${row.workingDays} working days`}>
            {rate}%
          </span>
        );
      },
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("hr-attendance", columns);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-1">
          <Link
            href={`/hr/attendance?month=${shiftMonth(month, -1)}`}
            aria-label={`Go to ${monthLabel(shiftMonth(month, -1))}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronLeft />
          </Link>
          <span className="min-w-32 text-center text-sm font-semibold">{monthLabel(month)}</span>
          <Link
            href={`/hr/attendance?month=${shiftMonth(month, 1)}`}
            aria-label={`Go to ${monthLabel(shiftMonth(month, 1))}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronRight />
          </Link>
          {month > thisMonth ? (
            <Badge variant="outline" className="ml-1">
              Not finished yet
            </Badge>
          ) : null}
        </div>

      </div>

      <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
        columns={columns}
        rows={rows}
        toolbar={
          <Input
            id="search"
            value={query}
            placeholder="Find someone by name or department"
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full sm:w-64"
            aria-label="Find someone"
          />
        }
        count={
          <>
            <span className="tabular-nums">{rows.length}</span>{" "}
            {rows.length === 1 ? "person" : "people"}
          </>
        }
        getRowKey={(row) => row.userId}
        empty="Nobody to show for this month."
      />
    </>
  );
}

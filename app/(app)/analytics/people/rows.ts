import { mean, percent, type PersonFigures } from "@/lib/performance";

import type { AverageRow, PersonRow } from "./people-table";

/** P15-02 — figures to the People table's plain rows. */
export function personRow(person: PersonFigures, department: string | null): PersonRow {
  const scheduled = person.attendance && !person.attendance.unscheduled;
  return {
    id: person.userId,
    name: person.name,
    department,
    open: person.workload.open,
    overdue: person.workload.overdue,
    completed: person.delivery.completed,
    onTime: percent(person.delivery.onTime),
    onTimeOf: person.delivery.onTime.of,
    cycleDays: person.delivery.cycleDays,
    firstPass: percent(person.delivery.firstPass),
    firstPassOf: person.delivery.firstPass.of,
    qaReturns: person.delivery.qaReturns,
    reviews: person.reviews,
    minutes: person.time.minutes,
    accounted: percent(person.time.accounted),
    timesheetsOnTime: percent({ hit: person.compliance.onTime, of: person.compliance.expected }),
    timesheetsExpected: person.compliance.expected,
    missingTimesheets: person.compliance.missing,
    late: scheduled ? person.attendance!.late : null,
    absent: scheduled ? person.attendance!.absent : null,
    rating: person.rating.average,
    ratingCount: person.rating.count,
  };
}

export function averageRow(rows: PersonRow[]): AverageRow {
  const avg = (pick: (row: PersonRow) => number | null) =>
    mean(rows.map(pick).filter((value): value is number => value !== null));
  return {
    open: avg((row) => row.open),
    overdue: avg((row) => row.overdue),
    completed: avg((row) => row.completed),
    onTime: avg((row) => row.onTime),
    cycleDays: avg((row) => row.cycleDays),
    firstPass: avg((row) => row.firstPass),
    qaReturns: avg((row) => row.qaReturns),
    reviews: avg((row) => row.reviews),
    minutes: avg((row) => row.minutes) ?? 0,
    accounted: avg((row) => row.accounted),
    timesheetsOnTime: avg((row) => row.timesheetsOnTime),
    missingTimesheets: avg((row) => row.missingTimesheets) ?? 0,
    late: avg((row) => row.late),
    absent: avg((row) => row.absent),
    rating: avg((row) => row.rating),
  } as AverageRow;
}


/**
 * Worse than the department average by a clear margin — a quarter of the
 * average, and never less than one. Shared by the table (▾) and the PDF
 * (orange), so both mark the same people.
 */
export function isWorse(value: number | null, average: number | null | undefined, better: "up" | "down") {
  if (value === null || average === null || average === undefined) return false;
  const margin = Math.max(1, Math.abs(average) * 0.25);
  return better === "up" ? value < average - margin : value > average + margin;
}

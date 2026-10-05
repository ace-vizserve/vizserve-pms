import { z } from "zod";

import type { VizservePmsRecurrenceFrequency } from "@/lib/database.types";
import { addDays, addMonths, daysBetween, isBusinessDay, startOfMonth, startOfWeek } from "@/lib/dates";

/**
 * P15-10 — RECURRING TASKS: the contract and the period arithmetic.
 *
 * The arithmetic is the database's (`vizserve_pms_period_start` and
 * `vizserve_pms_shift_into_period` in the p15_10 migration), restated here so
 * the UI can say "next copy: 12–16 Oct" before anything is saved. The tests pin
 * both to the same cases; if one changes, the other must.
 *
 * ⚠️ THE DATABASE DECIDES. This file previews. In particular `nextPeriod` on a
 * daily schedule skips weekends and the SEEDED holidays only (`isBusinessDay`
 * is a hint, never an authority — D31); the generator reads the holidays
 * table.
 */

export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const satisfies readonly VizservePmsRecurrenceFrequency[];
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** Where a new copy starts. "In Progress" is called Ongoing in this app. */
export const RECURRENCE_LANDING_STATUSES = ["ONGOING", "OPEN"] as const;
export type RecurrenceLandingStatus = (typeof RECURRENCE_LANDING_STATUSES)[number];
export const DEFAULT_LANDING_STATUS: RecurrenceLandingStatus = "ONGOING";

export const RECURRENCE_LABELS: Record<RecurrenceFrequency, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
};

/** The sentence beside the icon: what the schedule actually does. */
export const RECURRENCE_DESCRIPTIONS: Record<RecurrenceFrequency, string> = {
  DAILY: "Repeats every working day",
  WEEKLY: "Repeats weekly",
  MONTHLY: "Repeats monthly",
};

/** The handoff contract for setting a schedule (CLAUDE.md, D3a). */
export const setRecurrenceSchema = z.object({
  task_id: z.string().uuid(),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  landing_status: z.enum(RECURRENCE_LANDING_STATUSES).default(DEFAULT_LANDING_STATUS),
});
export type SetRecurrenceInput = z.input<typeof setRecurrenceSchema>;

/** The first day of the period `date` falls in: the day, the Monday, the 1st. */
export function periodStart(frequency: RecurrenceFrequency, date: string): string | null {
  if (frequency === "DAILY") return date;
  if (frequency === "WEEKLY") return startOfWeek(date);
  return startOfMonth(date);
}

/** The period after `period`. Daily skips weekends and seeded holidays (a preview). */
export function nextPeriod(frequency: RecurrenceFrequency, period: string): string | null {
  if (frequency === "WEEKLY") return addDays(period, 7);
  if (frequency === "MONTHLY") return addMonths(period, 1);

  let next = addDays(period, 1);
  // Bounded: a run of non-working days longer than three weeks is a broken table.
  for (let step = 0; next && step < 21 && !isBusinessDay(next); step += 1) next = addDays(next, 1);
  return next;
}

/** Whole months from one period start to another. Both are 1sts. */
function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/**
 * A date moved from one period into another, keeping its place in it: Mon–Fri
 * stays Mon–Fri, the 15th stays the 15th (clamped at a short month's end).
 */
export function shiftIntoPeriod(
  frequency: RecurrenceFrequency,
  date: string | null,
  fromPeriod: string,
  toPeriod: string,
): string | null {
  if (!date) return null;
  if (frequency === "MONTHLY") return addMonths(date, monthsBetween(fromPeriod, toPeriod));
  const days = daysBetween(fromPeriod, toPeriod);
  return days === null ? null : addDays(date, days);
}

/**
 * What the next copy will look like, for the picker's preview line.
 *
 * `anchor` is the task's start date, else its due date, else today — the same
 * order the database uses to decide which period a task covers.
 */
export function previewNextCopy(
  frequency: RecurrenceFrequency,
  task: { start_date: string | null; due_date: string | null },
  today: string,
): { period: string; start_date: string | null; due_date: string | null } | null {
  const current = periodStart(frequency, task.start_date ?? task.due_date ?? today);
  if (!current) return null;
  const period = nextPeriod(frequency, current);
  if (!period) return null;
  return {
    period,
    start_date: shiftIntoPeriod(frequency, task.start_date, current, period),
    due_date: shiftIntoPeriod(frequency, task.due_date, current, period),
  };
}

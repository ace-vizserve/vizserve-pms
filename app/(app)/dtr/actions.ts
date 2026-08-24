"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import { decimalHours, formatAppTime, workedMinutes } from "@/lib/dates";
import {
  describeLeaveDay,
  expandLeaveDays,
  leaveKey,
  type LeaveSpan,
} from "@/lib/leave";
import { dtrExportSchema, punchSchema, type PunchResult } from "@/lib/schemas/dtr";
import { createClient } from "@/utils/supabase/server";

/**
 * P5-02 / P5-11 — DTR mutations and the payroll export.
 *
 * Thin, like every other action file here. Earliest-in / latest-out, the
 * today-or-yesterday window and the 18-hour cut-off all live in
 * `vizserve_pms_punch`, because that is the copy a direct PostgREST call cannot
 * skip — and there is no INSERT or UPDATE policy on the table, so there is no
 * second path to keep in step.
 */

export type ActionResult<T = void> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Postgres raises a sentence; PostgREST wraps it. Show the sentence. */
function readableError(error: { message?: string } | null): string {
  const raw = error?.message ?? "";
  return (
    raw
      .replace(/^.*?(?:ERROR|error):\s*/i, "")
      .replace(/\s*CONTEXT:[\s\S]*$/, "")
      .trim() || "That did not go through. Try again."
  );
}

// ---------------------------------------------------------------------------
// P5-02 — punch
// ---------------------------------------------------------------------------

export async function punch(input: unknown): Promise<ActionResult<PunchResult>> {
  await requireAuthContextOrThrow();

  const parsed = punchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the form.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_punch", {
    p_direction: parsed.data.direction,
    // Only ever sent for a time-out; the schema makes it unrepresentable on
    // a time-in, and the function raises if one arrives anyway.
    p_work_date: parsed.data.direction === "out" ? (parsed.data.work_date ?? null) : null,
  });

  if (error) return { ok: false, error: readableError(error) };

  revalidatePath("/dtr");
  revalidatePath("/");
  revalidatePath("/dashboard");

  return { ok: true, data: data as unknown as PunchResult };
}

// ---------------------------------------------------------------------------
// P5-11 — payroll export
// ---------------------------------------------------------------------------

/** RFC 4180 quoting. A name with a comma must not become two columns. */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A month of DTR as CSV — the Phase 5 exit criterion.
 *
 * CSV rather than the `xlsx` the backlog floats: the exit criterion says CSV,
 * SheetJS is not currently a dependency, and payroll opens this in Excel either
 * way. Worth revisiting only if formatting or multiple sheets are actually
 * needed.
 *
 * No service-role client anywhere in here. The query runs as the signed-in user,
 * so RLS decides whose rows are exportable — a team leader gets their
 * departments and an admin gets everyone, without this function deciding
 * anything.
 */
export async function exportDtrCsv(
  input: unknown,
): Promise<ActionResult<{ filename: string; csv: string }>> {
  await requireAuthContextOrThrow();

  const parsed = dtrExportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the range.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { from, to, user_id } = parsed.data;
  const supabase = await createClient();

  const [entriesResult, leaveResult, peopleResult] = await Promise.all([
    (() => {
      let query = supabase
        .from("vizserve_pms_dtr_entries")
        // Same two-FK ambiguity as the list page — see the note there. This
        // export was refused by PostgREST for exactly the same reason, so the
        // payroll CSV has been failing too; it just failed into an error toast
        // rather than an empty screen.
        .select(
          "work_date, time_in, time_out, corrected_at, user_id, vizserve_pms_users!vizserve_pms_dtr_entries_user_id_fkey(full_name, email, work_start, work_end)",
        )
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: true });

      if (user_id) query = query.eq("user_id", user_id);
      return query;
    })(),

    /*
     * APPROVED LEAVE, and the reason the export was wrong without it.
     *
     * A day off has no `dtr_entries` row — approving leave writes nothing into
     * the DTR, deliberately, because it is not a time anybody was at work. So
     * the CSV simply had no line for it, and an approved absence arrived at
     * payroll looking exactly like a day somebody was rostered and did not turn
     * up. That is the one mistake a time record must not make.
     *
     * Read through the ORDINARY policy on internal requests
     * (`requester_id = auth.uid() or vizserve_pms_manages_department(...)`),
     * NOT through `vizserve_pms_leave_calendar`. The calendar is SECURITY
     * DEFINER and returns every active user, which is right for an
     * out-of-office widget and wrong here — it would put people outside the
     * caller's scope into a payroll file. This policy is the same shape as the
     * DTR's own, so the two queries cover the same population by construction.
     *
     * `reason` is deliberately not selected. Payroll needs to know somebody was
     * away and under which leave type; why they were away is between them and
     * the lead who approved it.
     *
     * OVERLAP, not containment — leave running across the range boundary counts
     * for the days that fall inside it. `expandLeaveDays` clamps.
     */
    (() => {
      let query = supabase
        .from("vizserve_pms_internal_requests")
        .select(
          "requester_id, start_date, end_date, start_half, end_half, vizserve_pms_leave_types(label)",
        )
        .eq("request_type", "LEAVE")
        .eq("status", "APPROVED")
        .lte("start_date", to)
        .gte("end_date", from);

      if (user_id) query = query.eq("requester_id", user_id);
      return query;
    })(),

    // Names for people who appear ONLY in the leave rows. Somebody away for the
    // whole range has no DTR row to carry their name, and an unnamed line in a
    // payroll file is worse than no line at all.
    supabase.from("vizserve_pms_users").select("id, full_name, email"),
  ]);

  if (entriesResult.error) return { ok: false, error: readableError(entriesResult.error) };
  // Leave failing is not the same as leave being absent, and quietly exporting
  // without it would reintroduce the exact bug this query fixes.
  if (leaveResult.error) return { ok: false, error: readableError(leaveResult.error) };

  type Row = {
    work_date: string;
    time_in: string | null;
    time_out: string | null;
    corrected_at: string | null;
    user_id: string;
    vizserve_pms_users: {
      full_name: string;
      email: string;
      /** P7-36. `HH:MM:SS` or null. Sliced for the export; payroll wants HH:MM. */
      work_start: string | null;
      work_end: string | null;
    } | null;
  };

  type LeaveRequestRow = {
    requester_id: string;
    start_date: string | null;
    end_date: string | null;
    start_half: "MORNING" | "AFTERNOON" | null;
    end_half: "MORNING" | "AFTERNOON" | null;
    vizserve_pms_leave_types: { label: string } | null;
  };

  const spans: LeaveSpan[] = ((leaveResult.data ?? []) as unknown as LeaveRequestRow[])
    // The shape constraint guarantees both dates on a LEAVE row; the types do
    // not, and a null here would expand into an unbounded walk.
    .filter((row) => row.start_date !== null && row.end_date !== null)
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half,
      end_half: row.end_half,
      type_name: row.vizserve_pms_leave_types?.label ?? null,
    }));

  const leaveDays = expandLeaveDays(spans, from, to);

  const person = new Map(
    ((peopleResult.data ?? []) as { id: string; full_name: string; email: string }[]).map(
      (row) => [row.id, row] as const,
    ),
  );

  type Line = {
    userId: string;
    name: string;
    email: string;
    workDate: string;
    timeIn: string;
    timeOut: string;
    hours: string;
    leave: string;
    corrected: string;
    /**
     * P7-36. The schedule this day was measured against, exported so that a
     * lateness figure computed from this file can be checked against the same
     * numbers the screen used. Blank for anybody with no fixed schedule — which
     * payroll must read as "not applicable", never as 00:00.
     */
    scheduledIn: string;
    scheduledOut: string;
  };

  const lines: Line[] = [];
  const punched = new Set<string>();

  for (const row of (entriesResult.data ?? []) as unknown as Row[]) {
    const minutes = workedMinutes(row.time_in, row.time_out);
    const key = leaveKey(row.user_id, row.work_date);
    punched.add(key);

    const onLeave = leaveDays.get(key);

    lines.push({
      userId: row.user_id,
      name: row.vizserve_pms_users?.full_name ?? person.get(row.user_id)?.full_name ?? "",
      email: row.vizserve_pms_users?.email ?? person.get(row.user_id)?.email ?? "",
      workDate: row.work_date,
      timeIn: row.time_in ? formatAppTime(row.time_in) : "",
      timeOut: row.time_out ? formatAppTime(row.time_out) : "",
      // Blank, not 0, for an open shift — payroll sums this column and a zero
      // would be counted as a real worked day of no hours.
      hours: decimalHours(minutes),
      // A half day worked and half taken is one row, annotated — NOT two rows.
      // The hours are real and the absence is real, and splitting them would
      // double-count the date in any per-day tally payroll runs on this file.
      leave: onLeave ? describeLeaveDay(onLeave) : "",
      corrected: row.corrected_at ? "yes" : "",
      scheduledIn: row.vizserve_pms_users?.work_start?.slice(0, 5) ?? "",
      scheduledOut: row.vizserve_pms_users?.work_end?.slice(0, 5) ?? "",
    });
  }

  // Leave days with no punch at all. These are the lines that did not exist
  // before, and they carry no hours on purpose: the Hours column is what
  // payroll sums, and leave is not worked time. The Leave column is what says
  // the absence was approved.
  for (const [key, day] of leaveDays) {
    if (punched.has(key)) continue;

    const [userId = "", workDate = ""] = key.split("|");
    const who = person.get(userId);

    lines.push({
      userId,
      name: who?.full_name ?? "",
      email: who?.email ?? "",
      workDate,
      timeIn: "",
      timeOut: "",
      hours: "",
      leave: describeLeaveDay(day),
      corrected: "",
      // Blank on a leave-only line even for somebody who HAS a schedule. The
      // columns describe what a day was measured against, and an approved
      // absence is not measured against anything — printing 09:00 beside a day
      // off invites exactly the "they were late" reading the row exists to
      // prevent.
      scheduledIn: "",
      scheduledOut: "",
    });
  }

  // Date first, then name. The old query ordered on date alone, so with several
  // people in range the rows within a day came back in whatever order the
  // planner chose — and the synthesised leave lines have to land beside the
  // punched ones for the same day rather than in a block at the end.
  lines.sort(
    (a, b) =>
      a.workDate.localeCompare(b.workDate) ||
      a.name.localeCompare(b.name) ||
      a.userId.localeCompare(b.userId),
  );

  const header = [
    "Employee",
    "Email",
    "Work date",
    "Time in",
    "Time out",
    "Hours",
    "Scheduled in",
    "Scheduled out",
    "Leave",
    "Corrected",
  ];

  const rows = [header.join(",")];

  for (const line of lines) {
    rows.push(
      [
        csvCell(line.name),
        csvCell(line.email),
        csvCell(line.workDate),
        csvCell(line.timeIn),
        csvCell(line.timeOut),
        csvCell(line.hours),
        csvCell(line.scheduledIn),
        csvCell(line.scheduledOut),
        csvCell(line.leave),
        csvCell(line.corrected),
      ].join(","),
    );
  }

  return {
    ok: true,
    data: {
      filename: `vizserve-dtr-${from}-to-${to}.csv`,
      // Leading BOM: without it Excel reads UTF-8 as the system codepage and
      // mangles any non-ASCII name in the first column.
      csv: `﻿${rows.join("\r\n")}\r\n`,
    },
  };
}

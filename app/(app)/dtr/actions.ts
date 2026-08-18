"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import { decimalHours, formatAppTime, workedMinutes } from "@/lib/dates";
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

  let query = supabase
    .from("vizserve_pms_dtr_entries")
    // Same two-FK ambiguity as the list page — see the note there. This export
    // was refused by PostgREST for exactly the same reason, so the payroll CSV
    // has been failing too; it just failed into an error toast rather than an
    // empty screen.
    .select(
      "work_date, time_in, time_out, corrected_at, user_id, vizserve_pms_users!vizserve_pms_dtr_entries_user_id_fkey(full_name, email)",
    )
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date", { ascending: true });

  if (user_id) query = query.eq("user_id", user_id);

  const { data, error } = await query;
  if (error) return { ok: false, error: readableError(error) };

  type Row = {
    work_date: string;
    time_in: string | null;
    time_out: string | null;
    corrected_at: string | null;
    vizserve_pms_users: { full_name: string; email: string } | null;
  };

  const header = ["Employee", "Email", "Work date", "Time in", "Time out", "Hours", "Corrected"];

  const lines = [header.join(",")];

  for (const row of (data ?? []) as unknown as Row[]) {
    const minutes = workedMinutes(row.time_in, row.time_out);
    lines.push(
      [
        csvCell(row.vizserve_pms_users?.full_name),
        csvCell(row.vizserve_pms_users?.email),
        csvCell(row.work_date),
        csvCell(row.time_in ? formatAppTime(row.time_in) : ""),
        csvCell(row.time_out ? formatAppTime(row.time_out) : ""),
        // Blank, not 0, for an open shift — payroll sums this column and a zero
        // would be counted as a real worked day of no hours.
        csvCell(decimalHours(minutes)),
        csvCell(row.corrected_at ? "yes" : ""),
      ].join(","),
    );
  }

  return {
    ok: true,
    data: {
      filename: `vizserve-dtr-${from}-to-${to}.csv`,
      // Leading BOM: without it Excel reads UTF-8 as the system codepage and
      // mangles any non-ASCII name in the first column.
      csv: `﻿${lines.join("\r\n")}\r\n`,
    },
  };
}

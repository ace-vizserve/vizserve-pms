"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import {
  timesheetEntrySchema,
  timesheetEntryUpdateSchema,
} from "@/lib/schemas/timesheet";
import { createClient } from "@/utils/supabase/server";

/**
 * P6-02 — timesheet mutations.
 *
 * Thin, like every other action file here. There is no `user_id` in any payload
 * and none is set on write: the INSERT policy's `user_id = auth.uid()` decides
 * whose row this is, so "log time as someone else" is not a request the server
 * can be talked into. Same reason the task-ownership test is not repeated here
 * — `vizserve_pms_may_log_time` runs inside the policy, where PostgREST cannot
 * route around it.
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Postgres raises a sentence; PostgREST wraps it. Show the sentence. */
function readableError(error: { message?: string; code?: string } | null): string {
  const raw = error?.message ?? "";

  // A policy that refuses an INSERT surfaces as 42501 with PostgREST's own
  // wording about row-level security, which tells the person nothing they can
  // act on. There are only three ways to fail this policy, and naming them is
  // more use than the code.
  if (error?.code === "42501") {
    return "You can only log time against a task you are on, and only for a day that has happened.";
  }

  return (
    raw
      .replace(/^.*?(?:ERROR|error):\s*/i, "")
      .replace(/\s*CONTEXT:[\s\S]*$/, "")
      .trim() || "That did not go through. Try again."
  );
}

/**
 * Both the week view and the dashboard read this table, and an entry logged
 * from one and invisible in the other is the bug people report as "it did not
 * save".
 */
function revalidateTimesheet() {
  revalidatePath("/timesheet");
  revalidatePath("/dashboard");
}

export async function logTime(input: unknown): Promise<ActionResult> {
  const context = await requireAuthContextOrThrow();

  const parsed = timesheetEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the entry.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("vizserve_pms_timesheet_entries").insert({
    // Written explicitly because the column is NOT NULL and has no default.
    // The policy still has the final say — this value only ever equals
    // auth.uid(), and a mismatched one is refused rather than trusted.
    user_id: context.userId,
    task_id: parsed.data.task_id,
    work_date: parsed.data.work_date,
    minutes: parsed.data.minutes,
    note: parsed.data.note,
  });

  if (error) return { ok: false, error: readableError(error) };

  revalidateTimesheet();
  return { ok: true, data: undefined };
}

export async function updateTimeEntry(input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = timesheetEntryUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the entry.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  // No `.eq("user_id", …)`. The UPDATE policy scopes this to the caller's own
  // rows, and restating it here would imply the policy is optional.
  const { error } = await supabase
    .from("vizserve_pms_timesheet_entries")
    .update({
      task_id: parsed.data.task_id,
      work_date: parsed.data.work_date,
      minutes: parsed.data.minutes,
      note: parsed.data.note,
    })
    .eq("id", parsed.data.id);

  if (error) return { ok: false, error: readableError(error) };

  revalidateTimesheet();
  return { ok: true, data: undefined };
}

export async function deleteTimeEntry(id: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "That entry does not exist." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("vizserve_pms_timesheet_entries")
    .delete()
    .eq("id", parsed.data);

  if (error) return { ok: false, error: readableError(error) };

  revalidateTimesheet();
  return { ok: true, data: undefined };
}

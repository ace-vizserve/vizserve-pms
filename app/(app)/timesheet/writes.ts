"use client";

import { z } from "zod";

import { flattenIssues, readableError as sharedReadableError, type ActionResult } from "@/lib/action-result";
import { browserClient } from "@/lib/query/browser-client";
import {
  submitTimesheetWeekSchema,
  timesheetEntrySchema,
  timesheetEntryUpdateSchema,
  timesheetLayoutSchema,
  timesheetWeekDecisionSchema,
} from "@/lib/schemas/timesheet";
import { LOGGABLE_SEARCH_LIMIT, loadLoggableTasks, type LoggableTask } from "@/lib/timesheet-tasks";

/**
 * P12 Phase B — the timesheet's writes, browser → Supabase, no server hop.
 *
 * ⚠️ THE SAME CALLS `actions.ts` MADE, WITH THE SAME CHECKS AND THE SAME
 * SENTENCES. Every one of these was already a single policy-checked insert,
 * update, delete or database function — nothing here used the service role,
 * sent mail or ran a rule that lives only in TypeScript — so moving them changes
 * where the request starts, not what is allowed:
 *
 *   - the entry policies call `vizserve_pms_may_log_time` and
 *     `vizserve_pms_timesheet_week_locked`, so a locked week or a task somebody
 *     may not log against is refused by the database exactly as before;
 *   - submit / withdraw / decide are database functions that re-check the
 *     caller themselves.
 *
 * What is gone is the round trip through a Next function (and the queue Next
 * puts server actions in, one at a time per tab), and the `revalidatePath`
 * calls — the grid already owns its cache and invalidates it on settle.
 *
 * `actions.ts` stays for any server caller; nothing in the browser imports it.
 */

/** Postgres raises a sentence; PostgREST wraps it. Show the sentence. */
function readableError(error: { message?: string; code?: string } | null): string {
  if (error?.code === "42501") {
    return (
      "You can only log time against a task you are on, for a day no later than the " +
      "end of this week, in a week you have not submitted yet."
    );
  }

  return sharedReadableError(error);
}

const LOCKED_OR_GONE =
  "That week has been submitted, so its entries are read-only. Ask the manager to send it back.";

/**
 * The signed-in user's id, from the session the browser already holds — no
 * network call. The insert policy checks `user_id = auth.uid()` regardless, so
 * this only names the row; it cannot claim somebody else's.
 */
async function currentUserId(): Promise<string | null> {
  const { data } = await browserClient().auth.getSession();
  return data.session?.user.id ?? null;
}

const NOT_SIGNED_IN: ActionResult = { ok: false, error: "Your session has ended. Sign in again." };

export async function logTime(input: unknown): Promise<ActionResult> {
  const parsed = timesheetEntrySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the entry.", fieldErrors: flattenIssues(parsed.error) };
  }

  const userId = await currentUserId();
  if (!userId) return NOT_SIGNED_IN;

  const { error } = await browserClient().from("vizserve_pms_timesheet_entries").insert({
    user_id: userId,
    task_id: parsed.data.task_id,
    work_date: parsed.data.work_date,
    minutes: parsed.data.minutes,
    note: parsed.data.note,
    started_at: parsed.data.started_at,
    ended_at: parsed.data.ended_at,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}

export async function updateTimeEntry(input: unknown): Promise<ActionResult> {
  const parsed = timesheetEntryUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the entry.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { data, error } = await browserClient()
    .from("vizserve_pms_timesheet_entries")
    .update({
      task_id: parsed.data.task_id,
      work_date: parsed.data.work_date,
      minutes: parsed.data.minutes,
      note: parsed.data.note,
      started_at: parsed.data.started_at,
      ended_at: parsed.data.ended_at,
    })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  // A refused UPDATE is success with zero rows — the lock, said in words.
  if (!data || data.length === 0) return { ok: false, error: LOCKED_OR_GONE };
  return { ok: true, data: undefined };
}

export async function deleteTimeEntry(id: string): Promise<ActionResult> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "That entry does not exist." };

  const { data, error } = await browserClient()
    .from("vizserve_pms_timesheet_entries")
    .delete()
    .eq("id", parsed.data)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: LOCKED_OR_GONE };
  return { ok: true, data: undefined };
}

export async function submitTimesheetWeek(input: unknown): Promise<ActionResult> {
  const parsed = submitTimesheetWeekSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a week to submit." };

  const { error } = await browserClient().rpc("vizserve_pms_submit_timesheet_week", {
    p_week_start: parsed.data.week_start,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}

export async function withdrawTimesheetWeek(input: unknown): Promise<ActionResult> {
  const parsed = submitTimesheetWeekSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a week." };

  const { error } = await browserClient().rpc("vizserve_pms_withdraw_timesheet_week", {
    p_week_start: parsed.data.week_start,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}

export async function decideTimesheetWeek(weekId: string, input: unknown): Promise<ActionResult> {
  if (!z.uuid().safeParse(weekId).success) {
    return { ok: false, error: "That timesheet does not exist." };
  }

  const parsed = timesheetWeekDecisionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the decision.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { error } = await browserClient().rpc("vizserve_pms_decide_timesheet_week", {
    p_id: weekId,
    p_decision: parsed.data.decision,
    p_reason: parsed.data.reason ?? null,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: undefined };
}

/** P6-02d — the week's layout. Upserted on the viewer's own row, policy-checked. */
export async function saveTimesheetLayout(input: unknown): Promise<ActionResult> {
  const parsed = timesheetLayoutSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Could not save the week's layout.", fieldErrors: flattenIssues(parsed.error) };
  }

  const userId = await currentUserId();
  if (!userId) return NOT_SIGNED_IN;

  const { error } = await browserClient().from("vizserve_pms_timesheet_layouts").upsert(
    {
      user_id: userId,
      week_start: parsed.data.week_start,
      extra_task_ids: parsed.data.extra_task_ids,
      row_order: parsed.data.row_order,
      copied_last_week: parsed.data.copied_last_week,
    },
    { onConflict: "user_id,week_start" },
  );

  if (error) return { ok: false, error: sharedReadableError(error) };
  return { ok: true, data: undefined };
}

const taskSearchSchema = z.object({
  query: z.string().max(200).optional().nullable(),
  from: z.iso.date().optional().nullable(),
  to: z.iso.date().optional().nullable(),
  listId: z.uuid().optional().nullable(),
});

/** The Add-task picker's search — the same scoped read, from the browser. */
export async function searchLoggableTasks(input: unknown): Promise<ActionResult<{ tasks: LoggableTask[] }>> {
  const userId = await currentUserId();
  if (!userId) return NOT_SIGNED_IN as ActionResult<{ tasks: LoggableTask[] }>;

  // A malformed filter can only come from a control that produced it; the
  // honest answer is the unfiltered list, not an error where a list should be.
  const parsed = taskSearchSchema.safeParse(input ?? {});
  const filters = parsed.success ? parsed.data : {};

  const { tasks, error } = await loadLoggableTasks(browserClient(), userId, {
    ...filters,
    limit: LOGGABLE_SEARCH_LIMIT,
  });

  if (error) return { ok: false, error };
  return { ok: true, data: { tasks } };
}

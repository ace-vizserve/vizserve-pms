"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import {
  submitTimesheetWeekSchema,
  timesheetEntrySchema,
  timesheetEntryUpdateSchema,
  timesheetLayoutSchema,
  timesheetWeekDecisionSchema,
} from "@/lib/schemas/timesheet";
import {
  loadLoggableTasks,
  LOGGABLE_SEARCH_LIMIT,
  type LoggableTask,
} from "@/lib/timesheet-tasks-server";
import { createClient } from "@/utils/supabase/server";
import { flattenIssues, readableError as sharedReadableError } from "@/lib/action-result";

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

// Re-exported because components import the type from the action file they
// call, and moving the definition should not move 40 import statements.
import type { ActionResult } from "@/lib/action-result";
export type { ActionResult };

/** Postgres raises a sentence; PostgREST wraps it. Show the sentence. */
/**
 * The shared reader, plus the one case that is specific to this table.
 *
 * A policy that refuses an INSERT surfaces as 42501 with PostgREST's own wording
 * about row-level security, which tells the person nothing they can act on.
 * There are only three ways to fail this policy, and naming them is more use
 * than the code.
 *
 * ⚠️ THIS IS THE REASON THE SHARED HELPER TAKES `{ message?: string }` AND
 * NOTHING ELSE. Pushing the 42501 sentence down into `lib/action-result.ts`
 * would put timesheet wording in front of every other table's policy refusal.
 */
function readableError(error: { message?: string; code?: string } | null): string {
  if (error?.code === "42501") {
    return (
      "You can only log time against a task you are on, for a day that has happened, " +
      "in a week you have not submitted yet."
    );
  }

  return sharedReadableError(error);
}

/**
 * What a zero-row write means.
 *
 * Two causes, and the caller cannot tell them apart — the row is inside a
 * submitted week, or it is not theirs (which for them is indistinguishable from
 * gone). Naming the likely one is more use than describing both.
 */
const LOCKED_OR_GONE =
  "That week has been submitted, so its entries are read-only. Ask your lead to send it back.";

/**
 * Both the week view and the dashboard read this table, and an entry logged
 * from one and invisible in the other is the bug people report as "it did not
 * save".
 */
function revalidateTimesheet() {
  revalidatePath("/timesheet");
  revalidatePath("/");
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
    // P7-21. Both or neither — the schema has already refused a half-filled
    // pair, and the CHECK behind it would refuse one that got past.
    started_at: parsed.data.started_at,
    ended_at: parsed.data.ended_at,
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
  //
  // `.select("id")` is load-bearing, not decoration. A policy that refuses an
  // UPDATE is NOT an error — PostgREST reports success and affects zero rows —
  // so without asking for the rows back, an edit inside a submitted week would
  // report "Updated" and change nothing. INSERT is the exception: its WITH
  // CHECK raises 42501, which is why `logTime` needs no equivalent.
  const { data, error } = await supabase
    .from("vizserve_pms_timesheet_entries")
    .update({
      task_id: parsed.data.task_id,
      work_date: parsed.data.work_date,
      minutes: parsed.data.minutes,
      note: parsed.data.note,
      // Written on every update, including when both are null. Omitting them
      // would make clearing the times impossible — the row would keep whatever
      // it had while the form said otherwise.
      started_at: parsed.data.started_at,
      ended_at: parsed.data.ended_at,
    })
    .eq("id", parsed.data.id)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: LOCKED_OR_GONE };

  revalidateTimesheet();
  return { ok: true, data: undefined };
}

export async function deleteTimeEntry(id: string): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "That entry does not exist." };

  const supabase = await createClient();
  // Same zero-rows-is-not-an-error problem as the update above.
  const { data, error } = await supabase
    .from("vizserve_pms_timesheet_entries")
    .delete()
    .eq("id", parsed.data)
    .select("id");

  if (error) return { ok: false, error: readableError(error) };
  if (!data || data.length === 0) return { ok: false, error: LOCKED_OR_GONE };

  revalidateTimesheet();
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// P7-05 — handing a week in, and deciding on one
// ---------------------------------------------------------------------------

/**
 * Both actions are the usual thin wrapper: parse, call, revalidate.
 *
 * NOTE THE ABSENCE OF A ROLE CHECK ON `decideTimesheetWeek`. That is not an
 * oversight — the engine's `vizserve_pms_can_approve` decides scope inside
 * `vizserve_pms_record_decision`, and the self-approval guard lives in the
 * decide function. If this file ever grows an "is this person allowed to
 * decide" test, the engine has been bypassed and that is the bug.
 */
export async function submitTimesheetWeek(input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = submitTimesheetWeekSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a week to submit." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_submit_timesheet_week", {
    p_week_start: parsed.data.week_start,
  });

  if (error) return { ok: false, error: readableError(error) };

  revalidateTimesheet();
  return { ok: true, data: undefined };
}

/**
 * P6-02d — the week's LAYOUT: which empty rows the grid draws, what order every
 * row sits in, and whether the last-week shortcut has been used.
 *
 * Called on a debounce from `use-layout-autosave.ts`, which coalesces a burst
 * of changes into ONE of these. The whole layout goes every time, so a partial
 * payload cannot blank the two thirds it left out.
 *
 * ⚠️ NO `revalidateTimesheet()`, AND THAT IS THE POINT RATHER THAN AN OMISSION.
 * Revalidating re-runs `/timesheet` as a server component, which would rebuild
 * the grid under somebody's cursor every time a debounce fires — fighting the
 * local state that is already showing them the right thing, and throwing away a
 * half-typed cell on the way past. The stored layout only has to be right on
 * the NEXT load. `use-task-autosave.ts` makes the same call with `refresh: false`.
 *
 * ⚠️ NO WEEK-LOCK CHECK, here or in the policies. An arrangement is not hours;
 * refusing it on a submitted week would put an error toast on a read-only
 * screen for a write nobody asked for.
 *
 * The upsert is expressible because the table has a natural key — `unique
 * (user_id, week_start)`. The entries table deliberately does not, which is why
 * this is a table of its own rather than columns on something existing.
 */
export async function saveTimesheetLayout(input: unknown): Promise<ActionResult> {
  const context = await requireAuthContextOrThrow();

  const parsed = timesheetLayoutSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Could not save the week's layout.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("vizserve_pms_timesheet_layouts").upsert(
    {
      // Written explicitly because the column is NOT NULL with no default. The
      // policy still has the final say — this only ever equals auth.uid().
      user_id: context.userId,
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

/**
 * P7-05b — cancel a submitted week so it can be revised.
 *
 * The week is the caller's by construction: the function reads `auth.uid()` and
 * takes no user. The lead's screens are revalidated too, because the week has
 * just left their queue.
 */
export async function withdrawTimesheetWeek(input: unknown): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  const parsed = submitTimesheetWeekSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a week." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_withdraw_timesheet_week", {
    p_week_start: parsed.data.week_start,
  });

  if (error) return { ok: false, error: readableError(error) };

  revalidateTimesheet();
  revalidatePath("/timesheet/team");
  revalidatePath("/approvals");
  revalidatePath("/inbox");
  return { ok: true, data: undefined };
}

export async function decideTimesheetWeek(
  weekId: string,
  input: unknown,
): Promise<ActionResult> {
  await requireAuthContextOrThrow();

  if (!z.uuid().safeParse(weekId).success) {
    return { ok: false, error: "That timesheet does not exist." };
  }

  const parsed = timesheetWeekDecisionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the decision.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("vizserve_pms_decide_timesheet_week", {
    p_id: weekId,
    p_decision: parsed.data.decision,
    p_reason: parsed.data.reason ?? null,
  });

  if (error) return { ok: false, error: readableError(error) };

  revalidateTimesheet();
  revalidatePath("/timesheet/team");
  revalidatePath("/inbox");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// The picker's search
// ---------------------------------------------------------------------------

/**
 * Search the tasks you may log against.
 *
 * The picker loads the 20 most recently created and then asks the DATABASE for
 * anything else — so a task from three months ago is one search away rather
 * than absent, and the initial render does not carry every task somebody has
 * ever been on.
 *
 * ⚠️ NO `userId` PARAMETER, and there must not be one. The subject is the
 * caller, resolved here; a parameter would be one missing check away from
 * listing somebody else's work. `loadLoggableTasks` is the same scoping the
 * page uses and the same rule `vizserve_pms_may_log_time` enforces on write, so
 * the search cannot offer a task the insert would refuse.
 */
const taskSearchSchema = z.object({
  query: z.string().max(200).optional().nullable(),
  // `YYYY-MM-DD`, inclusive, matched as an overlap against the task's own
  // `start_date`..`due_date` window — see `loadLoggableTasks`.
  from: z.iso.date().optional().nullable(),
  to: z.iso.date().optional().nullable(),
  // A uuid, never a name — the options come from `loadLoggableTaskLists`, and
  // a list the caller is not on simply matches nothing rather than being an
  // error worth explaining.
  listId: z.uuid().optional().nullable(),
});

export async function searchLoggableTasks(
  input: unknown,
): Promise<ActionResult<{ tasks: LoggableTask[] }>> {
  const context = await requireAuthContextOrThrow();

  const parsed = taskSearchSchema.safeParse(input ?? {});
  // A malformed filter is not worth a sentence in a popover — it can only come
  // from a control that produced it, and the honest response is the unfiltered
  // list rather than an error where a list should be.
  const filters = parsed.success ? parsed.data : {};

  const { tasks, error } = await loadLoggableTasks(context.userId, {
    ...filters,
    limit: LOGGABLE_SEARCH_LIMIT,
  });

  if (error) return { ok: false, error };

  return { ok: true, data: { tasks } };
}

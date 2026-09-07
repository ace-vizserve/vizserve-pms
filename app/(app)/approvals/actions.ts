"use server";

import { revalidatePath } from "next/cache";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";
import {
  internalDecisionSchema,
  internalRequestSchema,
  isTimeCorrectionRequest,
} from "@/lib/schemas/internal-requests";
import { sanitizeRichText } from "@/lib/rich-text-server";
import { createClient } from "@/utils/supabase/server";
import { flattenIssues, readableError } from "@/lib/action-result";

/**
 * P5-06 / P5-08 — internal request submission and decisions.
 *
 * NOTE HOW LITTLE IS HERE, and specifically that there is no approval logic.
 * `vizserve_pms_decide_internal_request` calls the Phase 2 engine, which owns
 * scope, the mandatory reason on reject, the approval row and the audit entry.
 * If this file ever grows an "is this person allowed to decide" check, the
 * engine has been bypassed and that is the bug.
 */

// Re-exported because components import the type from the action file they
// call, and moving the definition should not move 40 import statements.
import type { ActionResult } from "@/lib/action-result";
export type { ActionResult };

function refresh(id?: string) {
  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/inbox");
  if (id) revalidatePath(`/approvals/${id}`);
}

// ---------------------------------------------------------------------------
// P5-06 — submit
// ---------------------------------------------------------------------------

export async function submitInternalRequest(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireAuthContextOrThrow();

  const parsed = internalRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the form.", fieldErrors: flattenIssues(parsed.error) };
  }

  const value = parsed.data;
  const supabase = await createClient();

  // The union means only the fields that belong to this type can even exist on
  // `value`, so the nulls below are structural rather than defensive.
  const { data, error } = await supabase.rpc("vizserve_pms_submit_internal_request", {
    p_request_type: value.request_type,
    // P7-56. Sanitised on write so the column stays tidy. This is NOT the
    // guard — `<RichText>` sanitises again on render, because this column is
    // also reachable from a SQL console and from rows written before P7-56.
    p_reason: sanitizeRichText(value.reason),
    p_start_date: value.request_type === "LEAVE" ? value.start_date : null,
    p_end_date: value.request_type === "LEAVE" ? value.end_date : null,
    // OVERTIME carries a work_date too, so this branch is not the correction
    // pair alone — a mistake that would submit an overtime request with a null
    // date and get it refused by the shape CHECK.
    p_work_date:
      isTimeCorrectionRequest(value) || value.request_type === "OVERTIME"
        ? value.work_date
        : null,
    // ⚠️ P7-39 WIDENED THIS TO FOUR TYPES, through the shared predicate rather
    // than a longer `||` chain. A fifth correction type added to
    // TIME_CORRECTION_TYPES and forgotten here would submit with a null
    // correction_time, and the error the user sees is the name of a check
    // constraint — the compiler cannot help, because the parameter has a SQL
    // default and is therefore optional to it.
    p_correction_time: isTimeCorrectionRequest(value) ? value.correction_time : null,
    p_amount: value.request_type === "REIMBURSEMENT" ? value.amount : null,
    // ⚠️ The Args type makes this OPTIONAL, because the SQL parameter has a
    // default — so omitting it would NOT be a compile error. It would submit
    // every overtime request with a null and let the shape CHECK reject it at
    // runtime. `tests/db/phase5.test.ts` is the guard, not the compiler.
    p_overtime_minutes: value.request_type === "OVERTIME" ? value.overtime_minutes : null,
    // ⚠️ Optional to the compiler for the same reason, and with a sharper
    // consequence: P7-12 made this REQUIRED on LEAVE at the constraint level, so
    // omitting it here does not degrade leave requests — it stops them
    // submitting at all.
    p_leave_type_id: value.request_type === "LEAVE" ? value.leave_type_id : null,
    // P7-16. Null for every other type — the shape constraint refuses a half on
    // a request that has no days, and the function coerces them anyway.
    p_start_half: value.request_type === "LEAVE" ? value.start_half : null,
    p_end_half: value.request_type === "LEAVE" ? value.end_half : null,
    // P9-01. Sent as sent; the function decides whether they were needed,
    // ignores them for a leave type that wants none, and re-checks every
    // person and every task. Nothing narrowed here is trusted server-side.
    p_relievers: value.request_type === "LEAVE" ? value.relievers : null,
    p_turnover_confirmed: value.request_type === "LEAVE" ? value.turnover_confirmed : false,
  });

  if (error) return { ok: false, error: readableError(error) };

  const result = data as unknown as { id: string };
  refresh(result.id);

  // Approvers were notified inside the function. Draining here rather than
  // awaiting it keeps a slow mail provider from making submission feel slow —
  // the outbox row is already written, so nothing is lost if this run fails.
  dispatchPendingEmailsInBackground();

  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// P5-08 — decide
// ---------------------------------------------------------------------------

export async function decideInternalRequest(
  requestId: string,
  input: unknown,
): Promise<ActionResult<{ status: string; dtrEntryId: string | null }>> {
  await requireAuthContextOrThrow();

  const parsed = internalDecisionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the form.", fieldErrors: flattenIssues(parsed.error) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_decide_internal_request", {
    p_id: requestId,
    p_decision: parsed.data.decision,
    p_reason: parsed.data.reason ? sanitizeRichText(parsed.data.reason) : null,
  });

  if (error) return { ok: false, error: readableError(error) };

  const result = data as unknown as { status: string; dtr_entry_id: string | null };

  refresh(requestId);
  // An approved correction rewrites a DTR row, so that list is stale too.
  if (result.dtr_entry_id) revalidatePath("/dtr");

  dispatchPendingEmailsInBackground();

  return { ok: true, data: { status: result.status, dtrEntryId: result.dtr_entry_id } };
}

// ---------------------------------------------------------------------------
// P9-03 — withdraw
// ---------------------------------------------------------------------------

/**
 * The submitter takes their own request back.
 *
 * Until P9-03 there was no third export in this file and no write path of any
 * kind for a requester: `vizserve_pms_internal_requests` carries a SELECT policy
 * and nothing else, so the only way to undo a mistyped leave request was to ask
 * a lead to REJECT it — which writes a refusal into the permanent record for
 * something nobody actually refused, and which Phase 6 will report as one.
 *
 * Every rule lives in `vizserve_pms_withdraw_internal_request`: you must be the
 * requester, it must still be pending, and nobody may have answered it yet —
 * including a reliever, whose answer lives on their own row rather than in
 * `vizserve_pms_approvals`. As with the two actions above, none of that is
 * re-asked here; a check in this file would be a second place for it to drift.
 */
export async function withdrawInternalRequest(
  requestId: string,
): Promise<ActionResult<{ status: string }>> {
  await requireAuthContextOrThrow();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_withdraw_internal_request", {
    p_id: requestId,
  });

  if (error) return { ok: false, error: readableError(error) };

  refresh(requestId);
  // Whoever it was waiting on was told inside the function.
  dispatchPendingEmailsInBackground();

  return { ok: true, data: data as unknown as { status: string } };
}

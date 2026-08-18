"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContextOrThrow } from "@/lib/auth/authorization";
import { dispatchPendingEmailsInBackground } from "@/lib/email/dispatch";
import { internalDecisionSchema, internalRequestSchema } from "@/lib/schemas/internal-requests";
import { createClient } from "@/utils/supabase/server";

/**
 * P5-06 / P5-08 — internal request submission and decisions.
 *
 * NOTE HOW LITTLE IS HERE, and specifically that there is no approval logic.
 * `vizserve_pms_decide_internal_request` calls the Phase 2 engine, which owns
 * scope, the mandatory reason on reject, the approval row and the audit entry.
 * If this file ever grows an "is this person allowed to decide" check, the
 * engine has been bypassed and that is the bug.
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

function readableError(error: { message?: string } | null): string {
  const raw = error?.message ?? "";
  return (
    raw
      .replace(/^.*?(?:ERROR|error):\s*/i, "")
      .replace(/\s*CONTEXT:[\s\S]*$/, "")
      .trim() || "That did not go through. Try again."
  );
}

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
    p_reason: value.reason,
    p_start_date: value.request_type === "LEAVE" ? value.start_date : null,
    p_end_date: value.request_type === "LEAVE" ? value.end_date : null,
    // OVERTIME carries a work_date too, so this branch is not the correction
    // pair alone — a mistake that would submit an overtime request with a null
    // date and get it refused by the shape CHECK.
    p_work_date:
      value.request_type === "NO_TIME_IN" ||
      value.request_type === "NO_TIME_OUT" ||
      value.request_type === "OVERTIME"
        ? value.work_date
        : null,
    p_correction_time:
      value.request_type === "NO_TIME_IN" || value.request_type === "NO_TIME_OUT"
        ? value.correction_time
        : null,
    p_amount: value.request_type === "REIMBURSEMENT" ? value.amount : null,
    // ⚠️ The Args type makes this OPTIONAL, because the SQL parameter has a
    // default — so omitting it would NOT be a compile error. It would submit
    // every overtime request with a null and let the shape CHECK reject it at
    // runtime. `tests/db/phase5.test.ts` is the guard, not the compiler.
    p_overtime_minutes: value.request_type === "OVERTIME" ? value.overtime_minutes : null,
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
    p_reason: parsed.data.reason ?? null,
  });

  if (error) return { ok: false, error: readableError(error) };

  const result = data as unknown as { status: string; dtr_entry_id: string | null };

  refresh(requestId);
  // An approved correction rewrites a DTR row, so that list is stale too.
  if (result.dtr_entry_id) revalidatePath("/dtr");

  dispatchPendingEmailsInBackground();

  return { ok: true, data: { status: result.status, dtrEntryId: result.dtr_entry_id } };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireHr } from "@/lib/auth/authorization";
import { setLeaveAllocationsSchema } from "@/lib/schemas/leave-balances";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-52 — leave allocations, org-wide.
 *
 * ⚠️ THE SINGLE IMPLEMENTATION of the allocation write. `/admin/users` used to
 * carry its own and now delegates here; the dialog on that screen and the grid
 * on this one do the same thing to the same rows, and the upsert's conflict
 * target is the sort of detail that must not exist twice — get it wrong in one
 * copy and an admin saving twice silently doubles somebody's entitlement.
 *
 * HR-gated, not admin-gated (P7-52). The RLS write policy on
 * `vizserve_pms_leave_balances` says the same since that migration, but the
 * service-role client below bypasses policies entirely, so `requireHr()` is
 * the belt.
 *
 * STILL NOT THE LEAD, and the reason p7_33:260-262 gave is unchanged: a team
 * leader deciding leave AND setting the allowance it is measured against is the
 * same person on both sides of the question. What P7-52 changed is only that
 * "HR" stopped being a synonym for "admin".
 *
 * ⚠️ NOTHING HERE TOUCHES USAGE, because nothing stores it. Days taken are
 * computed from approved requests by `vizserve_pms_leave_balance_summary` on
 * every read (D27) — which is why this file has no re-credit path, no
 * recalculation step and no way to leave a stale number behind. If you are
 * about to add a `days_used` column, read D27 first.
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

function revalidateBalanceScreens(): void {
  revalidatePath("/hr/balances");
  revalidatePath("/admin/users");
  // The figure the person themselves reads while filing leave comes off the
  // same rows, so this has to be invalidated too or raising somebody's
  // allowance would not show up until the cache expired.
  revalidatePath("/approvals");
}

/**
 * One person, one year, the whole set of types.
 *
 * UPSERT, NEVER DELETE-THEN-INSERT. An allocation of ZERO is a real statement —
 * "you get no vacation leave this year" — and deleting the row to express it
 * would make it indistinguishable from "nobody has decided yet". So every row
 * the form sends is written, zeroes included.
 */
export async function setLeaveAllocations(input: unknown): Promise<ActionResult> {
  const context = await requireHr();

  const parsed = setLeaveAllocationsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted figures.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const result = await writeAllocations(context.userId, parsed.data);
  if (!result.ok) return result;

  revalidateBalanceScreens();
  return { ok: true, data: undefined };
}

/**
 * The grid's save: many people, one year, in one call.
 *
 * ⚠️ NOT A TRANSACTION, and the choice is deliberate rather than overlooked.
 * Each person's allocations are written by the same upsert the single-person
 * path uses, in sequence, and a failure part way through leaves the people
 * already written saved. The alternative — a Postgres function taking the whole
 * grid as JSON — would be atomic and would also mean a second implementation of
 * the upsert living in SQL, which is the duplication this file exists to avoid.
 *
 * The failure is survivable because the operation is IDEMPOTENT: the grid posts
 * absolute figures rather than deltas, so re-saving after a partial failure
 * writes the same numbers again and lands in the same place. The action reports
 * how many people were saved before it stopped, so the person knows where they
 * are rather than having to guess.
 */
const bulkSchema = z
  .array(setLeaveAllocationsSchema)
  .min(1, "Nothing to save.")
  .max(200, "Too many people in one save — narrow the list first.");

export async function setLeaveAllocationsBulk(
  input: unknown,
): Promise<ActionResult<{ saved: number }>> {
  const context = await requireHr();

  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted figures.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  let saved = 0;
  for (const entry of parsed.data) {
    const result = await writeAllocations(context.userId, entry);
    if (!result.ok) {
      revalidateBalanceScreens();
      return {
        ok: false,
        error:
          saved === 0
            ? result.error
            : `${result.error} ${saved} ${saved === 1 ? "person was" : "people were"} saved before this; re-saving is safe.`,
      };
    }
    saved += 1;
  }

  revalidateBalanceScreens();
  return { ok: true, data: { saved } };
}

/** The shared write. Not exported — it does no authority check of its own. */
async function writeAllocations(
  actorId: string,
  values: z.infer<typeof setLeaveAllocationsSchema>,
): Promise<ActionResult> {
  const { user_id: userId, balance_year: year, allocations } = values;
  const admin = createAdminClient();

  const { data: subject } = await admin
    .from("vizserve_pms_users")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();

  if (!subject) return { ok: false, error: "That user no longer exists." };

  // Read before, so the audit row can say what the numbers were. Keyed by type
  // rather than by row id: the ids are meaningless to anyone reading the log,
  // and an upsert can mint new ones, which would make a before/after diff look
  // like a wholesale replacement of untouched rows.
  const { data: existing } = await admin
    .from("vizserve_pms_leave_balances")
    .select("leave_type_id, days_allocated")
    .eq("user_id", userId)
    .eq("balance_year", year);

  const before = Object.fromEntries(
    (existing ?? []).map((row) => [row.leave_type_id, row.days_allocated]),
  );

  if (allocations.length > 0) {
    const { error } = await admin.from("vizserve_pms_leave_balances").upsert(
      allocations.map((allocation) => ({
        user_id: userId,
        leave_type_id: allocation.leave_type_id,
        balance_year: year,
        days_allocated: allocation.days_allocated,
      })),
      // The unique constraint p7_33 adds for exactly this. Without a conflict
      // target, saving twice would insert a second allocation and silently
      // double somebody's entitlement.
      { onConflict: "user_id,leave_type_id,balance_year" },
    );

    if (error) {
      // A retired leave type still has a valid id, so a stale form could post
      // one. The foreign key accepts it — retiring is `is_active = false`, not
      // a delete — which is correct: the allocation stays attached to whatever
      // was actually allocated. Anything else that fails here is worth showing.
      return { ok: false, error: `${subject.full_name}: ${error.message}` };
    }
  }

  const after = Object.fromEntries(
    allocations.map((allocation) => [allocation.leave_type_id, allocation.days_allocated]),
  );

  // Only log a change that changed something — an audit trail full of no-op
  // saves is one nobody reads.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "user",
      p_entity_id: userId,
      p_action: "leave_allocation_set",
      p_actor_id: actorId,
      p_before: { balance_year: year, allocations: before },
      p_after: { balance_year: year, allocations: after },
    });
  }

  return { ok: true, data: undefined };
}

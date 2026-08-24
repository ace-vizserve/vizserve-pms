"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { APP_ACCESS_KEY, requireRole } from "@/lib/auth/authorization";
import type { LeaveBalanceSummaryRow } from "@/lib/database.types";
import { todayInAppZone } from "@/lib/dates";
import {
  balanceYearSchema,
  currentBalanceYear,
  setLeaveAllocationsSchema,
} from "@/lib/schemas/leave-balances";
import {
  groupLeaveReport,
  leaveReportFilename,
  renderLeaveReport,
} from "@/lib/reports/leave-report";
import {
  createUserSchema,
  normaliseManagedDepartments,
  updateUserSchema,
} from "@/lib/schemas/users";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

/**
 * P0-04 — user administration.
 *
 * Admin-only, and re-established on every call: `requireRole("admin")` first,
 * always, before anything reads a parameter. RLS says the same thing underneath,
 * but the service-role client below bypasses RLS entirely — so here the
 * TypeScript check is not belt-and-braces, it is the belt.
 *
 * Creating a user needs the Supabase admin API (there is no way to provision an
 * auth identity through a policy), which means service role, which means the
 * authority check is load-bearing. Every function in this file that reaches for
 * `createAdminClient()` does so AFTER `requireRole`.
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

/** The shape written to the audit log. Enough to answer "who had what, when". */
type AuditableProfile = {
  email: string;
  full_name: string;
  gender: string | null;
  role: string;
  primary_department_id: string | null;
  is_active: boolean;
  app_access: string[];
  managed_department_ids: string[];
};

async function readProfileForAudit(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<AuditableProfile | null> {
  const { data: profile } = await admin
    .from("vizserve_pms_users")
    .select("email, full_name, gender, role, primary_department_id, is_active, app_access")
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return null;

  const { data: managed } = await admin
    .from("vizserve_pms_user_managed_departments")
    .select("department_id")
    .eq("user_id", userId);

  return {
    ...profile,
    managed_department_ids: (managed ?? []).map((row) => row.department_id).sort(),
  };
}

/**
 * Replaces the managed set wholesale.
 *
 * Delete-then-insert rather than a diff: the set is at most four rows, and a
 * diff that drops a delete leaves someone holding scope they were meant to lose
 * — a failure that is invisible until it matters.
 */
async function replaceManagedDepartments(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  departmentIds: string[],
): Promise<string | null> {
  const { error: deleteError } = await admin
    .from("vizserve_pms_user_managed_departments")
    .delete()
    .eq("user_id", userId);

  if (deleteError) return deleteError.message;
  if (departmentIds.length === 0) return null;

  const { error: insertError } = await admin
    .from("vizserve_pms_user_managed_departments")
    .insert(departmentIds.map((department_id) => ({ user_id: userId, department_id })));

  return insertError?.message ?? null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createUser(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await requireRole("admin");

  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const managed = normaliseManagedDepartments(values.role, values.managed_department_ids);
  const admin = createAdminClient();

  // The database trigger on auth.users creates the profile row, so this is the
  // one operation that genuinely needs the admin API.
  //
  // NO `user_metadata` HERE. It would be a write of a display name rather than a
  // read for authorization, so it is not the danger D18 is about — but the upsert
  // below already sets `full_name` on the profile, which is the source of truth,
  // making the metadata copy redundant. Given the choice between a redundant
  // write and an allowlist entry, take the one that keeps `npm run check:metadata`
  // absolute. A rule with no exceptions is the only kind that stays enforced.
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: values.email,
    email_confirm: true,
  });

  if (authError || !created.user) {
    const message = authError?.message ?? "Could not create the account.";
    if (/already been registered|already exists/i.test(message)) {
      return {
        ok: false,
        error: "That email address already has an account.",
        fieldErrors: { email: ["Already registered."] },
      };
    }
    return { ok: false, error: message };
  }

  const userId = created.user.id;

  // Upsert rather than update: the trigger normally has the row in place, but an
  // update matching zero rows reports success, and a user with no profile can
  // sign in and see a broken app.
  const { error: profileError } = await admin.from("vizserve_pms_users").upsert(
    {
      id: userId,
      email: values.email,
      full_name: values.full_name,
      gender: values.gender,
      role: values.role,
      primary_department_id: values.primary_department_id,
      is_active: true,
      app_access: [APP_ACCESS_KEY],
    },
    { onConflict: "id" },
  );

  if (profileError) return { ok: false, error: profileError.message };

  const managedError = await replaceManagedDepartments(admin, userId, managed);
  if (managedError) return { ok: false, error: managedError };

  // Phase 0 exit criterion: an audit row on user create/edit.
  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "user",
    p_entity_id: userId,
    p_action: "created",
    p_actor_id: context.userId,
    p_before: null,
    p_after: await readProfileForAudit(admin, userId),
  });

  revalidatePath("/admin/users");
  return { ok: true, data: { id: userId } };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateUser(userId: string, input: unknown): Promise<ActionResult> {
  const context = await requireRole("admin");

  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const admin = createAdminClient();
  const before = await readProfileForAudit(admin, userId);

  if (!before) return { ok: false, error: "That user no longer exists." };

  // An admin who demotes or deactivates themselves locks the last door behind
  // them, and the recovery is a SQL console. Cheap to prevent, tedious to undo.
  if (userId === context.userId) {
    if (values.role !== "admin") {
      return { ok: false, error: "You cannot change your own role. Ask another admin." };
    }
    if (!values.is_active) {
      return { ok: false, error: "You cannot deactivate your own account." };
    }
    // Revoking your own app access locks you out mid-session, and the recovery
    // is a SQL console. Same reasoning as the role and is_active guards above.
    if (!values.has_app_access) {
      return { ok: false, error: "You cannot remove your own access to this app." };
    }
  }

  if (before.role === "admin" && (values.role !== "admin" || !values.is_active)) {
    const { count } = await admin
      .from("vizserve_pms_users")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_active", true);

    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: "This is the last active admin. Promote someone else first.",
      };
    }
  }

  const managed = normaliseManagedDepartments(values.role, values.managed_department_ids);

  // Note the absent email field — see lib/schemas/users.ts. Email is the
  // identity that links SSO and password login to one profile.
  const { error: updateError } = await admin
    .from("vizserve_pms_users")
    .update({
      full_name: values.full_name,
      gender: values.gender,
      role: values.role,
      primary_department_id: values.primary_department_id,
      is_active: values.is_active,
      // Revoking this closes every table at once — vizserve_pms_current_role()
      // returns null without it, and every policy funnels through that.
      app_access: values.has_app_access ? [APP_ACCESS_KEY] : [],
    })
    .eq("id", userId);

  if (updateError) return { ok: false, error: updateError.message };

  const managedError = await replaceManagedDepartments(admin, userId, managed);
  if (managedError) return { ok: false, error: managedError };

  const after = await readProfileForAudit(admin, userId);

  // Only record a change that actually changed something. An audit trail full of
  // no-op saves is an audit trail nobody reads.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "user",
      p_entity_id: userId,
      p_action: before.is_active && !values.is_active ? "deactivated" : "updated",
      p_actor_id: context.userId,
      p_before: before,
      p_after: after,
    });
  }

  revalidatePath("/admin/users");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Leave allocations (P7-33)
// ---------------------------------------------------------------------------

/**
 * Sets what HR allocates this person, per leave type, for one year.
 *
 * ADMIN ONLY, and deliberately not `manager` or `team_leader`. A lead who could
 * set the allowance and then approve leave measured against it is on both sides
 * of the same question; the RLS write policy on `vizserve_pms_leave_balances`
 * says the same thing underneath. The service-role client below bypasses that
 * policy, so `requireRole("admin")` here is the belt rather than the braces —
 * the same posture every other action in this file takes.
 *
 * UPSERT, NEVER DELETE-THEN-INSERT. `replaceManagedDepartments` above wipes and
 * rewrites because an empty managed set is meaningful and a missing row is the
 * only way to express it. Here the opposite holds: an allocation of ZERO is a
 * real statement — "you get no vacation leave this year" — and deleting the row
 * to express it would make it indistinguishable from "nobody has decided yet".
 * So every row the form sends is written, zeroes included.
 *
 * NOTHING HERE TOUCHES USAGE, because nothing stores it. Days taken are computed
 * from approved requests by `vizserve_pms_leave_balance_summary` each time it is
 * read, which is why this action has no re-credit path, no recalculation step
 * and no way to leave a stale number behind.
 */
export async function setLeaveAllocations(input: unknown): Promise<ActionResult> {
  const context = await requireRole("admin");

  const parsed = setLeaveAllocationsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted figures.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const { user_id: userId, balance_year: year, allocations } = parsed.data;
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
      // The unique constraint the migration adds for exactly this. Without a
      // conflict target an admin saving twice would insert a second allocation
      // and silently double somebody's entitlement.
      { onConflict: "user_id,leave_type_id,balance_year" },
    );

    if (error) {
      // A retired leave type still has a valid id, so a stale form could post
      // one. The foreign key accepts it — retiring is `is_active = false`, not
      // a delete — which is correct: the allocation stays attached to whatever
      // was actually allocated. Anything else that fails here is worth showing.
      return { ok: false, error: error.message };
    }
  }

  const after = Object.fromEntries(
    allocations.map((allocation) => [allocation.leave_type_id, allocation.days_allocated]),
  );

  // Only log a change that changed something — an audit trail full of no-op
  // saves is one nobody reads. Same rule as `updateUser` above.
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await admin.rpc("vizserve_pms_write_audit_log", {
      p_entity_type: "user",
      p_entity_id: userId,
      p_action: "leave_allocation_set",
      p_actor_id: context.userId,
      p_before: { balance_year: year, allocations: before },
      p_after: { balance_year: year, allocations: after },
    });
  }

  revalidatePath("/admin/users");
  // The figure the person themselves reads while filing leave comes off the
  // same rows, so the approvals page has to be invalidated too or an admin
  // raising somebody's allowance would not show up until the cache expired.
  revalidatePath("/approvals");
  return { ok: true, data: undefined };
}

/**
 * Allocated / used / remaining for one person, for the editor dialog.
 *
 * A server action rather than data on the page, because it is per-user and the
 * page renders the whole staff list: fetching it up front would be one RPC per
 * row to fill a panel almost all of which is never opened. This runs when a
 * dialog opens, once.
 *
 * Through the ORDINARY client, not the service role. The summary function does
 * its own authority check — caller must be the subject, their lead, or an admin
 * — and letting it run rather than bypassing it means this action cannot become
 * the hole in it. `requireRole("admin")` is still first, because that is what
 * this screen is.
 */
export async function readLeaveBalances(
  userId: string,
  year: number,
): Promise<ActionResult<LeaveBalanceSummaryRow[]>> {
  await requireRole("admin");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_leave_balance_summary", {
    p_user_id: userId,
    p_year: year,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: data ?? [] };
}

// ---------------------------------------------------------------------------
// Leave audit PDF (P7-34)
// ---------------------------------------------------------------------------

/**
 * The whole staff's leave for a year, as a PDF.
 *
 * Run in December, before January, so unused days can be settled or paid with
 * the bonus. It is an audit document — printed, checked against HR's manual
 * count, signed, filed — which is why it is a file rather than a screen and why
 * the page states the rules it counted by.
 *
 * RETURNED AS BASE64, not as a string of bytes. A Uint8Array does not survive
 * the server-action boundary intact, and a "binary string" would be re-encoded
 * as UTF-8 somewhere in the middle and arrive with every byte above 0x7F turned
 * into two — a PDF that is subtly, unopenably corrupt. Base64 is ASCII the whole
 * way and the client turns it back into bytes in three lines.
 *
 * ADMIN ONLY HERE, though `vizserve_pms_leave_report` would happily scope itself
 * to a lead's own departments. This action hangs off /admin/users, which is an
 * admin screen; the day a team leader wants their own team's figures, the SQL
 * already supports it and only this line has to change.
 */
export async function exportLeaveReportPdf(
  input: unknown,
): Promise<ActionResult<{ filename: string; base64: string }>> {
  const context = await requireRole("admin");

  // Defaults to this year in Manila when nothing is passed. December is exactly
  // when this is run, so a UTC server rolling over to January early would offer
  // the wrong year at the worst possible moment.
  const parsed = balanceYearSchema.safeParse(
    (input as { year?: unknown } | null)?.year ?? currentBalanceYear(todayInAppZone()),
  );

  if (!parsed.success) {
    return { ok: false, error: "Choose a year between 2020 and 2100." };
  }

  const year = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_leave_report", { p_year: year });
  if (error) return { ok: false, error: error.message };

  const rows = data ?? [];
  if (rows.length === 0) {
    // Not an empty PDF. A blank audit page is indistinguishable from a broken
    // export, and somebody would file it.
    return {
      ok: false,
      error: `Nothing to report for ${year} — no staff or leave types were in scope.`,
    };
  }

  const { data: profile } = await supabase
    .from("vizserve_pms_users")
    .select("full_name, email")
    .eq("id", context.userId)
    .maybeSingle();

  const bytes = renderLeaveReport(groupLeaveReport(rows), {
    year,
    generatedOn: todayInAppZone(),
    generatedBy: profile?.full_name || profile?.email || "an administrator",
    // Admin-only for now, per the note above. Printed either way, so the day
    // this becomes lead-scoped the page cannot quietly start lying about it.
    scope: "All departments",
  });

  return {
    ok: true,
    data: {
      filename: leaveReportFilename(year),
      base64: Buffer.from(bytes).toString("base64"),
    },
  };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Sends a reset link. Deliberately NOT "set a new password for them".
 *
 * An admin who can type a colleague's password can sign in as that colleague,
 * and every audit row after that names the wrong person. A reset link keeps the
 * credential between the user and GoTrue.
 */
export async function sendPasswordReset(userId: string): Promise<ActionResult> {
  await requireRole("admin");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("vizserve_pms_users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return { ok: false, error: "That user no longer exists." };

  // The user's own client, not the admin one — resetPasswordForEmail is a public
  // GoTrue endpoint and sends the mail Supabase owns.
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(profile.email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback`,
  });

  if (error) return { ok: false, error: error.message };

  return { ok: true, data: undefined };
}

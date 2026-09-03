"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { APP_ACCESS_KEY, requireRole } from "@/lib/auth/authorization";
import type { LeaveBalanceSummaryRow } from "@/lib/database.types";
import { setLeaveAllocations as setHrLeaveAllocations } from "@/app/(app)/hr/balances/actions";
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
 * Admin-only, and re-established on every call: `requireRole("owner")` first,
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
  is_hr: boolean;
  /** P8-01. The department-admin tick. Audited exactly as `is_hr` is. */
  is_dept_admin: boolean;
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
    .select(
      "email, full_name, gender, role, is_hr, is_dept_admin, primary_department_id, is_active, app_access, work_start, work_end, break_minutes",
    )
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

/**
 * Every screen that reads a person's role, department or schedule.
 *
 * ⚠️ `/admin/users` ALONE IS NOT ENOUGH, and the gap was invisible until P7-36.
 * A profile edit changes what `resolveAuth` returns, and half the app branches
 * on that: `/approvals` decides from `primary_department_id` whether a request
 * can route at all, `/dtr` and the punch panel read `work_start`/`work_end`, and
 * the nav reads the role. Revalidating only the screen the admin is standing on
 * left every one of those serving a cached payload — so setting somebody's
 * department and sending them to file a request showed them the same "you have
 * no department" notice they were sent there to clear.
 */
function revalidateProfileScreens(): void {
  revalidatePath("/admin/users");
  revalidatePath("/approvals");
  revalidatePath("/dtr");
  revalidatePath("/timesheet");
  revalidatePath("/dashboard");
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createUser(
  input: unknown,
): Promise<ActionResult<{ id: string; password: string; email: string }>> {
  const context = await requireRole("owner");

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
  /*
   * ⚠️ P8-11 — A PASSWORD IS SET HERE NOW, and without it this whole function
   * creates an account nobody can sign in to.
   *
   * It used to create the auth identity with no password at all, because the
   * only way in was the reset email — the new person got a link, chose their
   * own, and an admin never touched a credential. That email path is withdrawn,
   * so an account created with no password is an account with no route in at
   * all. The temporary password below is that route, and
   * `must_change_password` in the profile upsert is what makes it temporary.
   */
  const password = generateTemporaryPassword();

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: values.email,
    email_confirm: true,
    password,
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
      is_hr: values.is_hr,
      // P8-01. Same story as is_hr: settable only from this screen, which is
      // owner-gated, and that is what stops the tick appointing more of itself.
      is_dept_admin: values.is_dept_admin,
      primary_department_id: values.primary_department_id,
      is_active: true,
      app_access: [APP_ACCESS_KEY],
      // P7-36. Null means no fixed schedule, which is a supported state — the
      // DTR simply says nothing about this person's punches.
      work_start: values.work_start,
      work_end: values.work_end,
      // P8-05. Null means INHERIT the company break, and it is the normal state
      // — a new account has never been assessed for one. Writing 0 here would
      // claim they take no break and raise their weekly minimum accordingly.
      break_minutes: values.break_minutes,
      // P8-11. Set on creation, always. The password above was chosen by an
      // admin, so it is temporary by definition — and this is the flag that
      // stops it being permanent by accident.
      must_change_password: true,
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

  revalidateProfileScreens();
  // The password travels back to the screen that will show it once and forget
  // it. Same contract as `setTemporaryPassword`: it exists in this return value
  // and nowhere else.
  return { ok: true, data: { id: userId, password, email: values.email } };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateUser(userId: string, input: unknown): Promise<ActionResult> {
  const context = await requireRole("owner");

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

  // An owner who demotes or deactivates themselves locks the last door behind
  // them, and the recovery is a SQL console. Cheap to prevent, tedious to undo.
  //
  // ⚠️ P8-01 CHANGED THE LITERAL HERE, AND IT HAD TO. This read `!== "admin"`,
  // and the migration promotes every admin to `owner` — so left alone it would
  // have refused an owner's own save with "You cannot change your own role"
  // even when they had changed nothing at all, because the role they submit is
  // now `owner` and never `admin` again. Same for the last-active check below.
  if (userId === context.userId) {
    if (values.role !== "owner") {
      return { ok: false, error: "You cannot change your own role. Ask another owner." };
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

  if (before.role === "owner" && (values.role !== "owner" || !values.is_active)) {
    const { count } = await admin
      .from("vizserve_pms_users")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner")
      .eq("is_active", true);

    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: "This is the last active owner. Promote someone else first.",
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
      // P7-52. Only reachable from this screen, which is owner-gated — that is
      // what stops HR appointing HR.
      is_hr: values.is_hr,
      // P8-01, and the same sentence again: a department admin cannot reach
      // this screen, so it cannot make another department admin or promote
      // itself out of its own department.
      is_dept_admin: values.is_dept_admin,
      primary_department_id: values.primary_department_id,
      is_active: values.is_active,
      // Revoking this closes every table at once — vizserve_pms_current_role()
      // returns null without it, and every policy funnels through that.
      app_access: values.has_app_access ? [APP_ACCESS_KEY] : [],
      // P7-36. Clearing both fields is a real edit, not a no-op: it turns off
      // every lateness prompt for this person, which is the supported way to say
      // "they do not work fixed hours".
      work_start: values.work_start,
      work_end: values.work_end,
      // P8-05. Clearing this is a real edit too: it hands the person back to
      // the company break rather than pinning them to whatever number was
      // there. Null and 0 are different answers all the way down to the CHECK.
      break_minutes: values.break_minutes,
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

  revalidateProfileScreens();
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Leave allocations (P7-33)
// ---------------------------------------------------------------------------

/**
 * Sets what HR allocates this person, per leave type, for one year.
 *
 * ⚠️ THE IMPLEMENTATION MOVED TO `app/(app)/hr/balances/actions.ts` IN P7-52.
 * It used to live here because /admin/users was the only screen that could set
 * an allocation; /hr/balances is now the org-wide version of the same edit, and
 * two copies of an upsert that silently doubles an entitlement if its conflict
 * target is wrong is not a thing to keep two of.
 *
 * Still exported from here, and still admin-gated, because the DIALOG on this
 * screen calls it. The shared action gates on `requireHr()`, which admins pass.
 */
export async function setLeaveAllocations(input: unknown): Promise<ActionResult> {
  await requireRole("owner");
  return setHrLeaveAllocations(input);
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
 * the hole in it. `requireRole("owner")` is still first, because that is what
 * this screen is.
 */
export async function readLeaveBalances(
  userId: string,
  year: number,
): Promise<ActionResult<LeaveBalanceSummaryRow[]>> {
  await requireRole("owner");

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

// P7-53 REMOVED `exportLeaveReportPdf` FROM HERE.
//
// It was the last trace of the one-click, whole-company download: a thin
// wrapper that parsed a year and called `exportLeaveReport`. The toolbar button
// now opens the same builder /hr/reports uses, in a dialog, and calls that
// action directly — so this wrapper had no caller and existed only to be found
// later and wondered about.
//
// The report itself lives in `app/(app)/hr/reports/actions.ts`, gated on a
// session rather than a role, because its three callers are an admin, an HR
// member and any employee printing their own record.

// ---------------------------------------------------------------------------
// Temporary passwords
// ---------------------------------------------------------------------------

/**
 * P8-11 — an owner issues a temporary password, and the holder must replace it.
 *
 * ⚠️ THIS REVERSES A DECISION THIS FILE USED TO STATE, and the reversal was
 * asked for deliberately, so the old reasoning is kept here rather than deleted.
 * `sendPasswordReset` mailed a link precisely because "an admin who can type a
 * colleague's password can sign in as that colleague, and every audit row after
 * that names the wrong person". That risk has not gone away. What has changed is
 * the trade: the email path was withdrawn, so the alternative to this is an
 * owner opening the Supabase dashboard — which is the same power with none of
 * the three mitigations below.
 *
 * The mitigations, and they are the whole justification:
 *
 *   1. `must_change_password` is set, so the credential is dead the moment its
 *      holder next signs in. `requireAuthContext` will not let them anywhere
 *      else, and `changeOwnPassword` refuses a "new" password that turns out to
 *      be the temporary one.
 *   2. An audit row names the owner who issued it. The window in which two
 *      people know one password is a matter of record, not a guess.
 *   3. It is SHOWN ONCE and stored nowhere. Not mailed, not logged, not
 *      returned by any later read — if the owner loses it before handing it
 *      over, the only recourse is to issue another, which writes another audit
 *      row.
 *
 * What is NOT claimed: this does not make the window safe, only short and
 * visible. Between issuing and first sign-in, an owner holds a working
 * credential for somebody else's account.
 */

/**
 * A password that satisfies `passwordSchema` and can be read down a phone.
 *
 * ⚠️ NO `0/O`, `1/l/I`, `5/S` — this string gets dictated aloud or typed off a
 * screen, and a temporary password that fails on the third attempt because
 * somebody heard an O for a zero is a support call, not security. Length makes
 * up for the smaller alphabet: 16 characters from ~50 symbols is far past
 * anything a login endpoint could be walked through.
 *
 * `crypto.getRandomValues`, never `Math.random()`. This is a live credential
 * for somebody else's account, and a predictable one would be worse than no
 * reset path at all.
 */
function generateTemporaryPassword(): string {
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const alphabet = lower + upper + digits;

  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);

  const body = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");

  /*
   * The policy demands upper, lower and a digit, and 16 random characters
   * satisfy that with overwhelming probability — but "overwhelming" is not
   * "always", and a generator that fails one time in ten thousand fails on
   * somebody's worst day. One guaranteed character of each class is prepended,
   * which is why the body is 16 and the result is 19.
   */
  const pick = (set: string) => {
    const one = new Uint32Array(1);
    crypto.getRandomValues(one);
    return set[one[0]! % set.length]!;
  };

  return pick(upper) + pick(lower) + pick(digits) + body;
}

/**
 * Issues a temporary password and returns it ONCE.
 *
 * The password is in the return value and nowhere else. It is deliberately not
 * in the audit payload, not in a notification and not in any column — an audit
 * trail an owner can read must never carry a way to take over the account it is
 * recording, which was true of the reset link this replaces and is more true of
 * a live password.
 */
export async function setTemporaryPassword(
  userId: string,
): Promise<ActionResult<{ password: string; email: string }>> {
  const context = await requireRole("owner");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("vizserve_pms_users")
    .select("email, full_name")
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return { ok: false, error: "That user no longer exists." };

  const password = generateTemporaryPassword();

  const { error: authError } = await admin.auth.admin.updateUserById(userId, { password });
  if (authError) return { ok: false, error: authError.message };

  /*
   * ⚠️ THE FLAG IS SET AFTER THE PASSWORD, AND A FAILURE HERE IS REPORTED.
   *
   * By this point the account's password HAS changed — reporting a clean
   * failure would send an owner away believing the old one still worked, while
   * its holder is locked out. And silently succeeding would leave somebody
   * holding an owner-chosen password with nothing forcing them to replace it,
   * which is the entire point of this function.
   */
  const { error: flagError } = await admin
    .from("vizserve_pms_users")
    .update({ must_change_password: true })
    .eq("id", userId);

  if (flagError) {
    return {
      ok: false,
      error: `The password was changed to "${password}", but we could not mark it as temporary. Give it to them and ask them to change it manually.`,
    };
  }

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "user",
    p_entity_id: userId,
    p_action: "temporary_password_set",
    p_actor_id: context.userId,
    p_before: null,
    // Who it was for, never what it was. See the note above the function.
    p_after: { email: profile.email },
  });

  revalidateProfileScreens();

  return { ok: true, data: { password, email: profile.email } };
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/authorization";
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
  role: string;
  primary_department_id: string | null;
  is_active: boolean;
  managed_department_ids: string[];
};

async function readProfileForAudit(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<AuditableProfile | null> {
  const { data: profile } = await admin
    .from("vizserve_pms_users")
    .select("email, full_name, role, primary_department_id, is_active")
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
      role: values.role,
      primary_department_id: values.primary_department_id,
      is_active: true,
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
      role: values.role,
      primary_department_id: values.primary_department_id,
      is_active: values.is_active,
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

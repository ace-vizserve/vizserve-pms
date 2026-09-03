"use server";

import { revalidatePath } from "next/cache";
import { createClient as createStandaloneClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getAuthContext, loadMustChangePassword } from "@/lib/auth/authorization";
import { sniffMatchesDeclaredType, safeStorageName, formatBytes } from "@/lib/attachments";
import {
  ALLOWED_SOUND_MIME_TYPES,
  MAX_SOUND_BYTES,
  type SoundKey,
} from "@/lib/preferences";
import { loadUserPreferences, SOUND_BUCKET } from "@/lib/preferences-server";
import { changeOwnPasswordSchema, forcedPasswordChangeSchema } from "@/lib/schemas/auth";
import { userPreferencesSchema } from "@/lib/schemas/preferences";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

/**
 * P8-11 / P8-12 — the actions behind a person's own settings screen.
 *
 * ⚠️ EVERY ONE OF THESE IS FIRST-PERSON, and none of them takes a user id.
 * The subject is always `context.userId`, resolved from the session here. An
 * action that accepted "whose password" or "whose preferences" as a parameter
 * would be one missing check away from letting anybody rewrite anybody — and
 * there is no legitimate caller who needs to name somebody else. The one
 * administrative counterpart, `setTemporaryPassword`, lives on the owner-gated
 * `/admin/users` screen where it belongs.
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

/**
 * ⚠️ A CLIENT THAT HOLDS NO COOKIES, used only to ASK GoTrue whether a password
 * is correct.
 *
 * `signInWithPassword` on `utils/supabase/server`'s client would succeed and, as
 * a side effect, mint a new session and write it over the caller's cookies —
 * rotating a live refresh token as the by-product of a validation check. That
 * works, right up until it does not, and the failure would be somebody signed
 * out mid-form with no explanation.
 *
 * `persistSession: false` and no cookie adapter means the token this issues is
 * discarded the moment the function returns. The publishable key, not the
 * secret one: this is the same public endpoint the login form uses, and it must
 * be, because the whole point is to ask GoTrue rather than to assert.
 */
function passwordChecker() {
  return createStandaloneClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * P8-11 — changing your own password.
 *
 * Replaces the reset email entirely (see the P8-11 migration). Two shapes,
 * decided by the SERVER rather than by the caller:
 *
 *   - ordinary: signed in, knows the current password, wants a new one. The
 *     current password is required, because a session is a laptop left unlocked
 *     as often as it is the person it belongs to.
 *   - forced: `must_change_password` is set, so an owner handed this person a
 *     temporary password minutes ago and they are being made to replace it.
 *     Retyping the temporary password is friction with nothing behind it.
 *
 * ⚠️ WHICH SHAPE APPLIES IS READ FROM THE DATABASE, NEVER FROM THE INPUT. A
 * `mode` parameter would be a switch anybody could flip to skip the
 * current-password check on an account they had merely found signed in.
 */
export async function changeOwnPassword(input: unknown): Promise<ActionResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: "Your session has expired. Sign in again." };

  const forced = await loadMustChangePassword(context.userId);
  const checker = passwordChecker();

  let password: string;

  if (forced) {
    const parsed = forcedPasswordChangeSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the highlighted fields.",
        fieldErrors: flattenIssues(parsed.error),
      };
    }
    password = parsed.data.password;

    /*
     * ⚠️ THE ONE CHECK THE FORCED PATH CANNOT DO IN ZOD: is the "new" password
     * the temporary one they were just given?
     *
     * `changeOwnPasswordSchema` compares the two fields it holds; here there is
     * no current password to compare against, so the question is put to GoTrue
     * instead — if signing in with the NEW password works, it is already the
     * current one. Letting that through would clear `must_change_password`
     * while leaving the handed-over credential in place, which is precisely the
     * state the flag exists to end.
     */
    const { error: reuse } = await checker.auth.signInWithPassword({
      email: context.email,
      password,
    });

    if (!reuse) {
      return {
        ok: false,
        error: "Check the highlighted fields.",
        fieldErrors: {
          password: ["That is the temporary password you were given. Choose a different one."],
        },
      };
    }
  } else {
    const parsed = changeOwnPasswordSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the highlighted fields.",
        fieldErrors: flattenIssues(parsed.error),
      };
    }
    password = parsed.data.password;

    const { error: wrong } = await checker.auth.signInWithPassword({
      email: context.email,
      password: parsed.data.currentPassword,
    });

    if (wrong) {
      /*
       * DELIBERATELY NOT `wrong.message`. GoTrue's own text distinguishes a bad
       * password from a rate limit from an unconfirmed email, and none of that
       * is useful to somebody who mistyped — while "over_email_send_rate_limit"
       * in a form field is alarming for no reason. The one thing worth saying
       * is the one thing they can act on.
       */
      return {
        ok: false,
        error: "Check the highlighted fields.",
        fieldErrors: { currentPassword: ["That is not your current password."] },
      };
    }
  }

  // The real, cookie-bound client — this is the call that has to land on the
  // caller's own session.
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) return { ok: false, error: error.message };

  /*
   * Clearing the flag needs the SERVICE ROLE. There is no self-update policy on
   * `vizserve_pms_users` — by design, since a person who could clear their own
   * flag could keep the temporary password — so the caller's own client would
   * match zero rows and report success.
   */
  const admin = createAdminClient();

  if (forced) {
    const { error: flagError } = await admin
      .from("vizserve_pms_users")
      .update({ must_change_password: false })
      .eq("id", context.userId);

    /*
     * ⚠️ REPORTED, NOT SWALLOWED, and the password has ALREADY CHANGED by the
     * time this can fail. Saying "that did not work" would be a lie that sends
     * somebody back to their old password; saying nothing would leave them
     * looping on /change-password with a password that is already correct.
     * Naming both facts is the only honest answer.
     */
    if (flagError) {
      return {
        ok: false,
        error:
          "Your password was changed, but we could not clear the temporary-password flag. Sign out and in again — if you are still asked to change it, tell an admin.",
      };
    }
  }

  await admin.rpc("vizserve_pms_write_audit_log", {
    p_entity_type: "user",
    p_entity_id: context.userId,
    p_action: "password_changed",
    p_actor_id: context.userId,
    // NO BEFORE AND NO AFTER. The only fact worth recording is that it
    // happened, and a payload here could only ever be a password or a hint at
    // one. `forced` says which route it came through, which is the thing
    // somebody reading the trail actually wants to know.
    p_before: null,
    p_after: { forced },
  });

  revalidatePath("/settings");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Reminder preferences
// ---------------------------------------------------------------------------

/**
 * P8-12 — save the reminder settings.
 *
 * UPSERT, because most people have no row: there is no backfill and no create
 * trigger, so the first save is an insert and every one after it is an update.
 * An `update` here would match zero rows and report success, and the form would
 * cheerfully say "Saved" forever.
 *
 * Through the CALLER'S OWN CLIENT, not the service role — the RLS on this table
 * is `user_id = auth.uid()` in all three directions, and running it as the
 * caller means the policy is the thing enforcing first-person-ness rather than
 * the `context.userId` written below. Both agree; only one of them survives
 * somebody editing this file carelessly.
 */
export async function saveReminderPreferences(input: unknown): Promise<ActionResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: "Your session has expired. Sign in again." };

  const parsed = userPreferencesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const values = parsed.data;
  const supabase = await createClient();

  /*
   * ⚠️ `sound_key` AND `custom_sound_path` ARE NOT WRITTEN HERE, and leaving
   * them out is what keeps the row and the bucket in step. The CHECK constraint
   * pairs `sound_key = 'default'` with a null path, so a form that could set the
   * key would strand the uploaded object the moment somebody went back to the
   * chime — unreachable, unreferenced, and swept by nothing. Those two columns
   * belong to `uploadReminderSound` and `removeReminderSound`, which are the
   * only callers that can change the storage and the row together.
   *
   * On INSERT they take their column defaults ('default', null), which is
   * exactly right for somebody who has never uploaded anything.
   */
  const { error } = await supabase.from("vizserve_pms_user_preferences").upsert(
    {
      user_id: context.userId,
      clock_in_reminder: values.clock_in_reminder,
      clock_out_reminder: values.clock_out_reminder,
      reminder_lead_minutes: values.reminder_lead_minutes,
      sound_volume: values.sound_volume,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { ok: false, error: error.message };

  // The shell reads these to drive the reminder, and the shell is on every
  // page — so the layout has to re-render, not just this screen.
  revalidatePath("/", "layout");

  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Custom sound upload
// ---------------------------------------------------------------------------

export type UploadedSound = { path: string; filename: string; size: number };

/**
 * P8-12 — replace the reminder sound with one of your own.
 *
 * Follows `uploadTaskAttachment` step for step, because the hazards are
 * identical: measure the real bytes, sniff the real magic number, upload, then
 * write the row, then remove the object if the write failed.
 *
 * ⚠️ `File.type` IS A CLAIM, NOT A FACT — the browser sets it from the
 * extension, so `payload.exe` renamed to `chime.mp3` arrives declaring
 * audio/mpeg. The sniff is what makes the allowlist mean anything.
 *
 * ⚠️ AND THE BUCKET IS NOT `request-attachments`. That bucket's rules live in
 * `vizserve_pms_attachment_rules`, which the PUBLIC client form reads — adding
 * audio there so staff could pick a ringtone would also let an anonymous
 * submitter post audio through a client form.
 */
export async function uploadReminderSound(formData: FormData): Promise<ActionResult<UploadedSound>> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: "Your session has expired. Sign in again." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a sound file to upload." };
  }

  if (file.size > MAX_SOUND_BYTES) {
    return {
      ok: false,
      error: `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_SOUND_BYTES)} — a reminder sound only needs to be a few seconds long.`,
    };
  }

  const declared = file.type;
  if (!(ALLOWED_SOUND_MIME_TYPES as readonly string[]).includes(declared)) {
    return {
      ok: false,
      error: "That file type is not accepted. Use an MP3, WAV, OGG, M4A or WebM audio file.",
    };
  }

  // The first 64 bytes are enough for every signature in the table, and reading
  // the whole file to check its first four bytes is waste on the server.
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const sniff = sniffMatchesDeclaredType(head, declared);
  if (!sniff.ok) return { ok: false, error: sniff.reason };

  const admin = createAdminClient();
  const existing = await loadUserPreferences(context.userId);

  /*
   * A fresh UUID rather than overwriting the previous object at a stable path,
   * and the reason is caching. The signed URL for a sound lives eight hours and
   * may already be in a browser somewhere; overwriting in place would leave
   * that tab playing the OLD file until its URL expired, which is a bug nobody
   * could reproduce. A new path means the new sound is a new URL.
   */
  const storagePath = `sounds/${context.userId}/${crypto.randomUUID()}/${safeStorageName(file.name)}`;

  const { error: uploadError } = await admin.storage
    .from(SOUND_BUCKET)
    .upload(storagePath, file, { contentType: declared, upsert: false });

  if (uploadError) return { ok: false, error: "That file could not be uploaded. Please try again." };

  const supabase = await createClient();
  const { error: rowError } = await supabase.from("vizserve_pms_user_preferences").upsert(
    {
      user_id: context.userId,
      // Uploading IS choosing it. Storing a sound the person then has to select
      // separately is a two-step where the second step is always the same.
      sound_key: "custom" satisfies SoundKey,
      custom_sound_path: storagePath,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (rowError) {
    // An object with no row pointing at it is unreachable. Remove it now rather
    // than leaving it to accumulate — nothing sweeps this prefix.
    await admin.storage.from(SOUND_BUCKET).remove([storagePath]);
    return { ok: false, error: "The upload could not be saved. Please try again." };
  }

  /*
   * ⚠️ THE OLD OBJECT GOES LAST, AFTER the row that points at the new one is
   * committed. One sound per person, so the previous file is dead the moment
   * the row moves — but deleting it first would mean a failed upsert left
   * somebody with a row naming an object that no longer exists.
   *
   * A failure here is an orphaned object, which nobody sees. A failure the
   * other way round is a silent reminder, which everybody does.
   */
  if (existing.customSoundPath && existing.customSoundPath !== storagePath) {
    await admin.storage.from(SOUND_BUCKET).remove([existing.customSoundPath]);
  }

  revalidatePath("/", "layout");

  return { ok: true, data: { path: storagePath, filename: file.name, size: file.size } };
}

/**
 * Go back to the sound that ships with the app.
 *
 * Clears the row first and removes the object second, for the same ordering
 * reason as the swap above: an orphan is invisible, a dangling path is not.
 */
export async function removeReminderSound(): Promise<ActionResult> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: "Your session has expired. Sign in again." };

  const existing = await loadUserPreferences(context.userId);
  if (!existing.customSoundPath) return { ok: true, data: undefined };

  const supabase = await createClient();
  const { error } = await supabase
    .from("vizserve_pms_user_preferences")
    .update({
      sound_key: "default" satisfies SoundKey,
      custom_sound_path: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", context.userId);

  if (error) return { ok: false, error: error.message };

  await createAdminClient().storage.from(SOUND_BUCKET).remove([existing.customSoundPath]);

  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

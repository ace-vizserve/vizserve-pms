import "server-only";

import { cache } from "react";

import {
  DEFAULT_USER_PREFERENCES,
  isSoundKey,
  type UserPreferences,
} from "@/lib/preferences";
import { signAttachmentUrl } from "@/lib/attachments-server";
import { createClient } from "@/utils/supabase/server";

/**
 * P8-12 — a person's own preferences, read once per request.
 *
 * `cache()`d for the same reason `loadAppSettings` is: the app shell reads it to
 * drive the reminder, and `/settings` reads it again to render the form. One
 * read per request, shared.
 *
 * ⚠️ FALLS BACK RATHER THAN THROWING, and the fallback is what the migration
 * defaults every column to. This is read in `app/(app)/layout.tsx` — the one
 * component on EVERY authenticated page — so a failed read here would be a
 * whole-app outage in exchange for a ringtone. The three ways it can fail all
 * deserve the same answer:
 *
 *   - the row does not exist, which is the NORMAL state (there is no backfill
 *     and no create trigger, so most people never have one);
 *   - the table does not exist yet, because migrations in this repo are pasted
 *     by hand after the code is deployed (CLAUDE.md);
 *   - an RLS wobble or a network fault.
 *
 * None of them is worth a broken shell, and the visible symptom of degrading is
 * a reminder that fires at the default fifteen minutes with the default sound.
 *
 * There is deliberately NO `fellBack` flag of the kind `AppSettings` carries.
 * That exists because the break minutes feed a REFUSAL — a screen telling
 * somebody their week is short of a threshold it read wrong. Nothing here
 * refuses anything or accuses anyone; every consumer is a nudge.
 */
export const loadUserPreferences = cache(async (userId: string): Promise<UserPreferences> => {
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_user_preferences")
    .select(
      "clock_in_reminder, clock_out_reminder, reminder_lead_minutes, sound_key, custom_sound_path, sound_volume",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return DEFAULT_USER_PREFERENCES;

  /*
   * `sound_key` is a text column with a CHECK, not an enum, so the generated
   * types call it `string`. Narrowing it through `isSoundKey` rather than
   * asserting is what keeps a hand-edited row from reaching the browser as a
   * key nothing knows how to play — the honest response to an unrecognised
   * sound is the one that ships with the app.
   *
   * ⚠️ AND THE PATH IS DROPPED WITH IT. The CHECK constraint pairs
   * `sound_key = 'custom'` with a non-null path, but a degraded read must not
   * assume the constraint held — returning `custom` with no path is a
   * configured-looking reminder that plays nothing.
   */
  const soundKey =
    isSoundKey(data.sound_key) && (data.sound_key !== "custom" || data.custom_sound_path)
      ? data.sound_key
      : "default";

  return {
    clockInReminder: data.clock_in_reminder,
    clockOutReminder: data.clock_out_reminder,
    leadMinutes: data.reminder_lead_minutes,
    soundKey,
    customSoundPath: soundKey === "custom" ? data.custom_sound_path : null,
    soundVolume: data.sound_volume,
  };
});

/** The bucket uploaded ringtones live in. Private; see the P8-11 migration. */
export const SOUND_BUCKET = "user-sounds";

/**
 * How long a signed sound URL lasts.
 *
 * EIGHT HOURS, where an attachment download gets sixty seconds, and the
 * difference is what the URL is for. An attachment link is clicked within
 * moments of being minted. This one is handed to a component that will not use
 * it until the end of somebody's shift — a sixty-second URL would be expired
 * every single time the reminder actually fired, which is the one moment it
 * matters. A working day is the natural span, so the URL outlives the tab it
 * was rendered into.
 */
const SOUND_URL_TTL_SECONDS = 8 * 60 * 60;

/**
 * A playable URL for whatever sound this person has chosen.
 *
 * Returns null for the shipped default — that one is served from `public/` at a
 * stable path, needs no signing, and the caller substitutes
 * `DEFAULT_SOUND_SRC`. Signing is only ever about the uploaded case.
 */
export async function signSoundUrl(preferences: UserPreferences): Promise<string | null> {
  if (preferences.soundKey !== "custom" || !preferences.customSoundPath) return null;

  return signAttachmentUrl(preferences.customSoundPath, SOUND_URL_TTL_SECONDS, SOUND_BUCKET);
}

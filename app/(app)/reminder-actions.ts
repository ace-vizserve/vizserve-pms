"use server";

import { getAuthContext } from "@/lib/auth/authorization";
import { loadWorkingDay } from "@/lib/dtr-server";
import { loadUserPreferences, signSoundUrl } from "@/lib/preferences-server";

/**
 * P8-12 / P12-23 — THE HALF OF THE CLOCK REMINDER THE BROWSER CANNOT READ.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS IS A READ THROUGH A SERVER ACTION AND IT IS THE ONLY ONE IN THE
 * MIGRATION. The plan of record says reads go browser-to-PostgREST, because
 * Next SERIALISES Server Action requests — they are POSTs that queue one at a
 * time per client — so a cache firing six parallel reads through actions would
 * run them end to end. That rule stands and this is a stated exception, for one
 * reason:
 *
 *   THE SOUND URL NEEDS THE SERVICE ROLE. `user-sounds` is a PRIVATE bucket
 *   (`20260904090000_p8_11`) with no storage policy for `authenticated`, so
 *   `signAttachmentUrl` mints its signature with the admin client. A browser
 *   cannot do it, and there is no version of "read it from PostgREST instead"
 *   that reaches an object in a private bucket.
 *
 * The exception is bounded by three things:
 *
 *   1. THE PUNCH STATE LEFT. `loadPunchState`'s four reads are gone from here —
 *      they are `qk.punchState()`, read from the browser and SHARED with the
 *      punch panel on `/`, `/dashboard` and `/dtr`. On those three pages the
 *      reminder now costs nothing at all.
 *   2. ONE REQUEST, NOT SIX, and never in parallel with anything.
 *   3. A LONG `staleTime`. It moves when somebody changes their preferences on
 *      `/settings`, and at midnight when the working-day answer changes. See
 *      `qk.reminderSetup()`.
 *
 * ⚠️ AND THE ORIGINAL MISTAKE STAYS FIXED. This was first fed from
 * `app/(app)/layout.tsx`, which put `loadPunchState`'s six reads plus a
 * preferences read on the critical path of EVERY authenticated page. `/timesheet`
 * and `/dtr` already issue large batches of their own, so those pages went from
 * roughly eight concurrent requests to fifteen or more and started failing with
 * `TypeError: fetch failed` — the timesheet picker first, then the DTR. A NUDGE
 * MUST NOT BE ON THE CRITICAL PATH OF EVERY PAGE. Nothing here is needed to
 * render anything and the first reminder cannot fire for minutes, so it is
 * fetched after paint. The cache is what stops it being fetched again on every
 * navigation, which the interval version could not.
 *
 * `getAuthContext` rather than `requireAuthContext`: this must never redirect.
 * It is called from a component that renders on every page including
 * `/change-password`, and an action that redirects out from under a background
 * fetch is a page that navigates itself for no visible reason.
 * ------------------------------------------------------------------------
 */

export type ReminderSetup = {
  /** P8-12 — is today a day this person is expected to work at all? */
  isWorkingDay: boolean;
  clockInLeadMinutes: number;
  clockOutLeadMinutes: number;
  clockInReminder: boolean;
  clockOutReminder: boolean;
  /** Null for the shipped chime, which is served from `public/` and needs no signing. */
  soundUrl: string | null;
  soundVolume: number;
};

/**
 * Null means "there is nothing to watch", and the browser stops asking.
 *
 * ⚠️ THE NO-SCHEDULE CASE IS NO LONGER DECIDED HERE. P7-36's null work hours are
 * a supported state meaning "this person works no fixed hours", and `dueReminder`
 * can never fire for them — but the schedule lives on `qk.punchState()` now, so
 * `ShiftReminder` makes that call against the cached punch state instead. This
 * function answers only the questions that need a server.
 */
export async function loadReminderSetup(): Promise<ReminderSetup | null> {
  const context = await getAuthContext();
  if (!context) return null;

  const [preferences, isWorkingDay] = await Promise.all([
    loadUserPreferences(context.userId),
    // Its own reader, deliberately not folded into `loadPunchState` — the punch
    // panel on three other pages calls that and has no use for this.
    loadWorkingDay(context.userId),
  ]);

  // Both switched off is the same answer: nothing to watch.
  if (!preferences.clockInReminder && !preferences.clockOutReminder) return null;

  // Only ever signed for somebody who actually uploaded a sound; the shipped
  // chime is served from `public/` and needs no signature.
  const soundUrl = await signSoundUrl(preferences);

  return {
    isWorkingDay,
    clockInLeadMinutes: preferences.clockInLeadMinutes,
    clockOutLeadMinutes: preferences.clockOutLeadMinutes,
    clockInReminder: preferences.clockInReminder,
    clockOutReminder: preferences.clockOutReminder,
    soundUrl,
    soundVolume: preferences.soundVolume,
  };
}

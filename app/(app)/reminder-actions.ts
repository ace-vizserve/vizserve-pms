"use server";

import { getAuthContext } from "@/lib/auth/authorization";
import { loadPunchState, loadWorkingDay } from "@/lib/dtr-server";
import { loadUserPreferences, signSoundUrl } from "@/lib/preferences-server";
import type { WorkSchedule } from "@/lib/dtr-schedule";

/**
 * P8-12 — everything the clock reminder needs, fetched by the BROWSER.
 *
 * ⚠️ THIS EXISTS BECAUSE PUTTING IT IN THE LAYOUT WAS A MISTAKE, and the
 * mistake is worth writing down rather than quietly undoing.
 *
 * The reminder was first fed from `app/(app)/layout.tsx`, which meant
 * `loadPunchState` (six reads) and `loadUserPreferences` ran on EVERY
 * authenticated page — the shell renders on all of them. `/timesheet` and
 * `/dtr` already issue large batches of their own, so those pages went from
 * roughly eight concurrent requests to fifteen or more, and requests started
 * failing with `TypeError: fetch failed` — the timesheet picker first, because
 * it was the one whose error had just been made visible, and then the DTR.
 *
 * A NUDGE MUST NOT BE ON THE CRITICAL PATH OF EVERY PAGE. Nothing here is
 * needed to render anything: the component draws nothing and the first reminder
 * cannot fire for minutes. So it is fetched after mount, once, and refreshed on
 * a slow interval — which costs the render nothing at all and, unlike the
 * layout version, picks up a punch made in another tab without a navigation.
 *
 * `getAuthContext` rather than `requireAuthContext`: this must never redirect.
 * It is called from a component that renders on every page including
 * `/change-password`, and an action that redirects out from under a background
 * fetch is a page that navigates itself for no visible reason.
 */

export type ReminderState = {
  userId: string;
  workDate: string;
  schedule: WorkSchedule;
  timeIn: string | null;
  timeOut: string | null;
  approvedOvertimeMinutes: number;
  isWorkingDay: boolean;
  leadMinutes: number;
  clockInReminder: boolean;
  clockOutReminder: boolean;
  soundUrl: string | null;
  soundVolume: number;
};

export async function loadReminderState(): Promise<ReminderState | null> {
  const context = await getAuthContext();
  if (!context) return null;

  const [punch, preferences, isWorkingDay] = await Promise.all([
    loadPunchState(context.userId),
    loadUserPreferences(context.userId),
    // Its own reader, deliberately not folded into `loadPunchState` — the punch
    // panel on three other pages calls that and has no use for this.
    loadWorkingDay(context.userId),
  ]);

  /*
   * NULL FOR ANYBODY WITH NO SCHEDULE, and that is most of the point of doing
   * this here. P7-36's null work hours are a supported state meaning "this
   * person works no fixed hours", and `dueReminder` can never fire for them —
   * so the browser is told there is nothing to watch and stops asking.
   */
  if (!punch.schedule.workStart || !punch.schedule.workEnd) return null;

  // Both switched off is the same answer: nothing to watch.
  if (!preferences.clockInReminder && !preferences.clockOutReminder) return null;

  // Only ever signed for somebody who actually uploaded a sound; the shipped
  // chime is served from `public/` and needs no signature.
  const soundUrl = await signSoundUrl(preferences);

  return {
    userId: context.userId,
    workDate: punch.today?.work_date ?? "",
    schedule: punch.schedule,
    timeIn: punch.today?.time_in ?? null,
    timeOut: punch.today?.time_out ?? null,
    approvedOvertimeMinutes: punch.approvedOvertimeMinutes,
    isWorkingDay,
    leadMinutes: preferences.leadMinutes,
    clockInReminder: preferences.clockInReminder,
    clockOutReminder: preferences.clockOutReminder,
    soundUrl,
    soundVolume: preferences.soundVolume,
  };
}

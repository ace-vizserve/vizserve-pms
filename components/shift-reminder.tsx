"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";

import { loadReminderState, type ReminderState } from "@/app/(app)/reminder-actions";
import { formatAppTime } from "@/lib/dates";
import { effectiveEnd } from "@/lib/dtr-schedule";
import { describeReminder, dueReminder, reminderSeenKey } from "@/lib/reminders";
import { playReminderSound, reminderSoundSrc } from "@/lib/sound";

/**
 * P8-12 — the nudge fifteen minutes before you are meant to clock in or out.
 *
 * RENDERS NOTHING AND RETURNS `null`, exactly like `RealtimeNotifications` next
 * to it in the shell, and for the same reason: `app/(app)/layout.tsx` is a
 * server component and cannot hold a timer. Mounted there rather than on `/dtr`
 * so it is live on every authenticated page — a reminder that only fires while
 * you are already looking at your time record is a reminder for the one person
 * who does not need it.
 *
 * ⚠️ IT FETCHES ITS OWN DATA, AFTER MOUNT, AND THAT IS A CORRECTION.
 *
 * The first version took everything as props from the layout, which put
 * `loadPunchState`'s six reads plus a preferences read on the critical path of
 * EVERY authenticated page. `/timesheet` and `/dtr` issue large batches of
 * their own, and the combined burst started failing with
 * `TypeError: fetch failed` — first the timesheet's task picker, then the DTR's
 * table. A background nudge had been made a precondition for rendering the
 * screens it was meant to sit quietly behind.
 *
 * Nothing here is needed to draw anything and the first reminder cannot fire
 * for minutes, so it is fetched after paint and refreshed slowly. That costs
 * the render nothing, and it picks up a punch made in another tab without
 * needing a navigation — which the props version could not do.
 *
 * ⚠️ IT STILL WRITES NOTHING. No notification row, no audit row, no "dismissed"
 * flag. See the header of `lib/reminders.ts`: this is a nudge in a tab that is
 * already open, not a notification, and the only trace it leaves is the
 * `localStorage` key that stops it firing twice.
 */

/** How often to check whether a reminder is due. Worst case is 30s late. */
const TICK_MS = 30_000;

/**
 * How often to re-read the punch state.
 *
 * Five minutes, not thirty seconds. The facts move rarely — a punch, an
 * overtime approval — and the cost of being a few minutes stale is a reminder
 * that fires for somebody who has just clocked in elsewhere. The punch panel
 * calls `router.refresh()` on a captured punch, which re-mounts nothing here,
 * so this interval is what eventually notices.
 */
const REFRESH_MS = 5 * 60_000;

export function ShiftReminder() {
  const [state, setState] = useState<ReminderState | null>(null);

  useEffect(() => {
    let alive = true;

    function refresh() {
      /*
       * `.then`, and never awaited into the effect body: a synchronous setState
       * during an effect is a second render, and this one has no reason to
       * block paint at all. `alive` guards the unmount case — a reply arriving
       * after the shell has gone would set state on a dead component.
       *
       * Failures are SWALLOWED. This is the one place in this feature where
       * that is right: a reminder that could not load its own schedule has
       * nothing to say, and there is no screen here to put an error on. The
       * next refresh tries again.
       */
      void loadReminderState()
        .then((next) => {
          if (alive) setState(next);
        })
        .catch(() => {});
    }

    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  /*
   * ⚠️ THE STATE GOES IN A REF AND THE TICK DEPENDS ON NOTHING.
   *
   * Listing `state` as a dependency would tear down and recreate the 30-second
   * interval every time the five-minute refresh landed — survivable here, but
   * the same mistake with a faster refresh is a timer that never fires. The ref
   * is updated in its own effect, DECLARED FIRST so it has already run by the
   * time the tick below reads it.
   */
  const latest = useRef(state);

  useEffect(() => {
    latest.current = state;
  });

  useEffect(() => {
    function check() {
      const current = latest.current;
      // Nothing loaded yet, or nothing to watch — no schedule, or both
      // reminders switched off. `loadReminderState` returns null for all three.
      if (!current) return;

      /*
       * THE ONE LINE THAT MUST GO THROUGH `formatAppTime`. The business runs in
       * Manila and this component runs on whatever laptop is open —
       * `new Date().getHours()` is the viewer's zone, which is right only for
       * somebody physically there, and would fire a colleague's reminder eight
       * hours out. `lib/dtr-schedule.ts` states the same trap at length.
       */
      const nowClock = formatAppTime(new Date().toISOString());

      const due = dueReminder({
        nowClock,
        workStart: current.schedule.workStart,
        // Approved overtime moves the end of the day, so somebody authorised to
        // stay late is not nagged at their normal finish for doing exactly what
        // their lead signed off.
        workEnd: effectiveEnd(current.schedule.workEnd, current.approvedOvertimeMinutes),
        timeIn: current.timeIn,
        timeOut: current.timeOut,
        leadMinutes: current.leadMinutes,
        clockIn: current.clockInReminder,
        clockOut: current.clockOutReminder,
        working: current.isWorkingDay,
      });

      if (!due) return;

      const key = reminderSeenKey(current.userId, current.workDate, due.side);

      /*
       * ONCE PER DAY PER SIDE. The window is fifteen minutes wide and the tick
       * is thirty seconds, so without this the same reminder would arrive
       * thirty times.
       *
       * Wrapped, because `localStorage` THROWS rather than returning null in a
       * browser set to block site data. An exception here would kill the
       * interval and take the reminder with it — so a browser that cannot
       * remember gets reminded repeatedly, which is annoying and honest, rather
       * than not at all.
       */
      try {
        if (window.localStorage.getItem(key)) return;
        window.localStorage.setItem(key, String(Date.now()));
      } catch {
        // No memory available. Fall through and remind anyway.
      }

      const message = describeReminder(due);

      void playReminderSound(reminderSoundSrc(current.soundUrl), current.soundVolume);

      /*
       * The OS notification, only where it was granted. `requestPermission` is
       * never called from here — it must come from a user gesture, and the
       * button for that is on /settings. Asking on a timer is how a browser
       * decides to block the prompt permanently.
       *
       * `tag` collapses a repeat rather than stacking one: if the localStorage
       * guard above failed open, the notification tray still shows one.
       */
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(message, {
            body:
              due.side === "in"
                ? "Your shift starts soon. Open the DTR to time in."
                : "Your shift ends soon. Remember to time out.",
            tag: key,
          });
        }
      } catch {
        // Some browsers throw on `new Notification` outside a service worker.
        // The toast below is the floor and always renders.
      }

      /*
       * ALWAYS, and it is the part that actually works everywhere. Sound can be
       * refused by autoplay policy and notifications can be denied; a toast
       * needs no permission and no gesture. A plain `toast`, not
       * `toast.success` — nothing has succeeded, and a coloured toast with no
       * label would be state conveyed by colour alone.
       */
      toast(message, {
        description:
          due.side === "in" ? "Time in from the DTR or the dashboard." : "Time out before you go.",
        duration: 15_000,
        action: { label: "Open DTR", onClick: () => window.open("/dtr", "_self") },
      });
    }

    const timer = window.setInterval(check, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}

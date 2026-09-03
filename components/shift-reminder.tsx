"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { formatAppTime } from "@/lib/dates";
import { effectiveEnd, type WorkSchedule } from "@/lib/dtr-schedule";
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
 * ⚠️ EVERY DECISION IS MADE ON THE SERVER'S FACTS, and this component makes
 * none of its own. The schedule, the punches, the preferences and whether today
 * is a working day all arrive as props, computed by `loadPunchState` and
 * `loadUserPreferences`. What happens here is a clock tick and a comparison —
 * `dueReminder` is pure and unit-tested without a browser, which is why a
 * reminder due at 08:45 is testable without waiting until 08:45.
 *
 * ⚠️ AND IT WRITES NOTHING. No notification row, no audit row, no "dismissed"
 * flag. See the header of `lib/reminders.ts`: this is a nudge in a tab that is
 * already open, not a notification, and the only trace it leaves is the
 * `localStorage` key that stops it firing twice.
 */

/** How often to check. Half a minute, so the worst case is 30s late. */
const TICK_MS = 30_000;

export type ShiftReminderProps = {
  userId: string;
  /** Today's work date in app time — the key the "already fired" flag uses. */
  workDate: string;
  schedule: WorkSchedule;
  timeIn: string | null;
  timeOut: string | null;
  approvedOvertimeMinutes: number;
  isWorkingDay: boolean;
  leadMinutes: number;
  clockInReminder: boolean;
  clockOutReminder: boolean;
  /** A signed URL when they uploaded a sound; null for the shipped default. */
  soundUrl: string | null;
  soundVolume: number;
};

export function ShiftReminder(props: ShiftReminderProps) {
  /*
   * ⚠️ THE PROPS GO IN A REF, AND THE EFFECT DEPENDS ON NOTHING.
   *
   * The alternative — listing the props as dependencies — tears down and
   * recreates the interval on every navigation, because this is mounted in the
   * shell and the shell re-renders on every page change. A 30-second timer
   * restarted every 20 seconds never fires, which would be a reminder that
   * silently only worked for people who sit still.
   *
   * The ref is updated on every render, so the tick always reads current facts
   * while the interval itself outlives them.
   */
  const latest = useRef(props);

  /*
   * ⚠️ IN AN EFFECT, NOT DURING RENDER, and it has to be DECLARED BEFORE the
   * interval below. Effects run in declaration order, so this one has already
   * refreshed the ref by the time the mount effect calls `check()` for the
   * first time — writing the ref in the render body instead would be the same
   * behaviour with a lint error and a real hazard under concurrent rendering,
   * where a render can be thrown away after the write.
   */
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    function check() {
      const current = latest.current;

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

    // Once immediately: somebody who opens the app at 08:50 is already inside
    // the window, and waiting up to thirty seconds to say so is thirty seconds
    // of a fifteen-minute warning spent.
    check();

    const timer = window.setInterval(check, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}

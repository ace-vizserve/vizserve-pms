"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { loadReminderSetup } from "@/app/(app)/reminder-actions";
import { formatAppTime } from "@/lib/dates";
import { effectiveEnd } from "@/lib/dtr-schedule";
import { browserClient } from "@/lib/query/browser-client";
import { fetchPunchState } from "@/lib/query/fetchers/dtr";
import { qk } from "@/lib/query/keys";
import { describeReminder, dueReminder, reminderSeenKey } from "@/lib/reminders";
import { playReminderSound, reminderSoundSrc } from "@/lib/sound";

/**
 * P8-12 / P12-23 — the nudge fifteen minutes before you are meant to clock in or
 * out.
 *
 * RENDERS NOTHING AND RETURNS `null`, exactly like `RealtimeNotifications` next
 * to it in the shell, and for the same reason: `app/(app)/layout.tsx` is a
 * server component and cannot hold a timer. Mounted there rather than on `/dtr`
 * so it is live on every authenticated page — a reminder that only fires while
 * you are already looking at your time record is a reminder for the one person
 * who does not need it.
 *
 * ------------------------------------------------------------------------
 * ⚠️ IT IS MOUNTED IN THE SHELL, SO WHATEVER IT DOES COSTS EVERY ROUTE. That
 * sentence is the whole history of this component.
 *
 * The first version took everything as props from the layout, which put
 * `loadPunchState`'s six reads plus a preferences read on the critical path of
 * EVERY authenticated page. `/timesheet` and `/dtr` issue large batches of their
 * own, and the combined burst started failing with `TypeError: fetch failed` —
 * first the timesheet's task picker, then the DTR's table. A background nudge had
 * been made a precondition for rendering the screens it was meant to sit quietly
 * behind.
 *
 * The second version fetched everything itself, after mount, through ONE Server
 * Action, and refreshed on a five-minute interval. That fixed the burst and cost
 * a fresh round trip on every mount plus one every five minutes, forever, on
 * every page, with no cache and no sharing.
 *
 * P12-23 SPLITS IT IN TWO, AND THE SPLIT IS THE POINT:
 *
 *   `qk.punchState()`   — the punch, the schedule and the approved overtime.
 *                         A plain policy-scoped read, browser to PostgREST, and
 *                         THE SAME ENTRY the punch panel on `/`, `/dashboard`
 *                         and `/dtr` reads. On those three pages this costs
 *                         nothing at all, and a punch made in another tab moves
 *                         it through the same invalidation the panel uses.
 *   `qk.reminderSetup()` — preferences, the working-day answer and a SIGNED
 *                         sound URL, which needs the service role and therefore
 *                         stays on a Server Action. One request per tab on a long
 *                         `staleTime`, not one every five minutes.
 *
 * The five-minute interval is gone with it. `refetchOnWindowFocus` is on by
 * default (see `lib/query/client.ts`) and is a better trigger than a timer: the
 * moment somebody comes back to the tab is exactly when a stale punch state
 * matters, and a tab nobody is looking at does not need to poll.
 * ------------------------------------------------------------------------
 *
 * ⚠️ IT STILL WRITES NOTHING. No notification row, no audit row, no "dismissed"
 * flag. See the header of `lib/reminders.ts`: this is a nudge in a tab that is
 * already open, not a notification, and the only trace it leaves is the
 * `localStorage` key that stops it firing twice.
 */

/** How often to check whether a reminder is due. Worst case is 30s late. */
const TICK_MS = 30_000;

/**
 * How long the server half stays fresh.
 *
 * ⚠️ TEN MINUTES, AND IT IS A CEILING RATHER THAN A POLL. Nothing refetches on
 * this schedule; it is how long the cached answer is trusted before the next
 * mount or window focus goes and asks again. The facts move rarely — a
 * preference changed on `/settings`, a leave request approved, midnight — and
 * the cost of being ten minutes stale is a reminder that fires for somebody who
 * has just booked the afternoon off.
 */
const SETUP_STALE_MS = 10 * 60_000;

export function ShiftReminder({ viewerId }: { viewerId: string }) {
  /*
   * ⚠️ `viewerId` IS A PROP AND THE LAYOUT READS NOTHING FOR IT. It is already
   * in hand from the `requireAuthContext()` the layout runs for the auth gate,
   * so passing it costs no query — which is the distinction that matters, given
   * that feeding this component from the layout is what caused the request burst
   * in the first place. It names the row `fetchPunchState` narrows to; it
   * authorises nothing, and the DTR policy is what scopes the read.
   */
  const punch = useQuery({
    queryKey: qk.punchState(),
    queryFn: () => fetchPunchState(browserClient(), viewerId),
  });

  const setup = useQuery({
    queryKey: qk.reminderSetup(),
    queryFn: () => loadReminderSetup(),
    staleTime: SETUP_STALE_MS,
    /*
     * ⚠️ OFF, UNLIKE EVERY OTHER QUERY IN THE APP. `client.ts` turns focus
     * refetching on because an SPA is left open overnight and yesterday's data
     * must not survive into today. That reasoning is about data somebody is
     * LOOKING at; this is a background nudge, and refetching a signed storage URL
     * every time a tab regains focus is a Server Action round trip bought for
     * nothing on every route in the product. `staleTime` above is what keeps it
     * honest.
     */
    refetchOnWindowFocus: false,
  });

  /*
   * ⚠️ THE STATE GOES IN A REF AND THE TICK DEPENDS ON NOTHING.
   *
   * Listing the queries as dependencies would tear down and recreate the
   * 30-second interval every time either of them settled — survivable, but the
   * same mistake with a faster refetch is a timer that never fires. The ref is
   * updated in its own effect, DECLARED FIRST so it has already run by the time
   * the tick below reads it.
   *
   * ⚠️ AND IT IS NULL UNTIL BOTH HAVE LANDED, deliberately. `loadReminderSetup`
   * returns null when there is nothing to watch — both toggles off — and the
   * punch state is null while it is still loading or if it failed. A reminder
   * that could not load its own schedule has nothing to say, and there is no
   * screen here to put an error on; the next focus tries again.
   */
  const latest = useRef<{
    userId: string;
    workDate: string;
    workStart: string | null;
    workEnd: string | null;
    timeIn: string | null;
    timeOut: string | null;
    approvedOvertimeMinutes: number;
    setup: NonNullable<Awaited<ReturnType<typeof loadReminderSetup>>>;
  } | null>(null);

  useEffect(() => {
    const state = punch.data;
    const settings = setup.data;

    /*
     * NULL FOR ANYBODY WITH NO SCHEDULE, and that check moved here from the
     * server action along with the schedule itself. P7-36's null work hours are
     * a supported state meaning "this person works no fixed hours", and
     * `dueReminder` can never fire for them.
     */
    if (!state || !settings || !state.schedule.workStart || !state.schedule.workEnd) {
      latest.current = null;
      return;
    }

    latest.current = {
      userId: viewerId,
      workDate: state.today?.work_date ?? "",
      workStart: state.schedule.workStart,
      workEnd: state.schedule.workEnd,
      timeIn: state.today?.time_in ?? null,
      timeOut: state.today?.time_out ?? null,
      approvedOvertimeMinutes: state.approvedOvertimeMinutes,
      setup: settings,
    };
  });

  useEffect(() => {
    function check() {
      const current = latest.current;
      // Nothing loaded yet, or nothing to watch — no schedule, or both reminders
      // switched off.
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
        workStart: current.workStart,
        // Approved overtime moves the end of the day, so somebody authorised to
        // stay late is not nagged at their normal finish for doing exactly what
        // their lead signed off.
        workEnd: effectiveEnd(current.workEnd, current.approvedOvertimeMinutes),
        timeIn: current.timeIn,
        timeOut: current.timeOut,
        clockInLeadMinutes: current.setup.clockInLeadMinutes,
        clockOutLeadMinutes: current.setup.clockOutLeadMinutes,
        clockIn: current.setup.clockInReminder,
        clockOut: current.setup.clockOutReminder,
        working: current.setup.isWorkingDay,
      });

      if (!due) return;

      const key = reminderSeenKey(current.userId, current.workDate, due.side);

      /*
       * ONCE PER DAY PER SIDE. The window is fifteen minutes wide and the tick
       * is thirty seconds, so without this the same reminder would arrive thirty
       * times.
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

      void playReminderSound(
        reminderSoundSrc(current.setup.soundUrl),
        current.setup.soundVolume,
      );

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

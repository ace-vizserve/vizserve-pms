import "server-only";

import { cache } from "react";

import { todayInAppZone, yesterdayInAppZone } from "@/lib/dates";
import { scheduleFor } from "@/lib/dtr-schedule";
import { loadAppSettings } from "@/lib/settings-server";
import type { PunchState } from "@/app/(app)/dtr/punch-panel";
import { createClient } from "@/utils/supabase/server";

/**
 * Today's DTR row plus yesterday's, if yesterday was left open — and, since
 * P7-40, everything needed to judge whether today's punches landed on schedule.
 *
 * Shared by the dashboard shortcut (P5-03) and the DTR page (P5-04) so the two
 * cannot disagree about whether you are clocked in — which they would within a
 * week if each ran its own query. The schedule half is here for the same reason:
 * the punch panel renders on three screens, and three copies of "are they late"
 * is three chances to disagree about the same punch.
 *
 * Both days come back in ONE round trip. The yesterday half is only ever needed
 * to decide whether to offer the overnight time-out, so a second query for a
 * value that is null on almost every load is not worth the latency.
 *
 * `cache()`d since P8-12: the clock reminder reads it too, through
 * `app/(app)/reminder-actions.ts`, so one request that renders the panel and
 * answers the reminder pays for these reads once. Same reasoning as
 * `loadAppSettings`. The argument is part of the key, so a lead's page reading
 * their own state cannot collide with anything.
 */
export const loadPunchState = cache(async (userId: string): Promise<PunchState> => {
  const today = todayInAppZone();
  const yesterday = yesterdayInAppZone();

  const supabase = await createClient();

  // Four reads, no dependencies between them. The settings read is `cache()`d,
  // so a page rendering the panel AND the DTR table pays for it once.
  const [entries, profile, overtime, settings] = await Promise.all([
    supabase
      .from("vizserve_pms_dtr_entries")
      .select("work_date, time_in, time_out")
      .eq("user_id", userId)
      .in("work_date", [today, yesterday]),
    supabase
      .from("vizserve_pms_users")
      .select("work_start, work_end")
      .eq("id", userId)
      .maybeSingle(),
    /**
     * Overtime ALREADY APPROVED for today, which extends the day this person is
     * expected to work. Without it, staying two hours late on a day their lead
     * signed off reads as a deviation and the app asks them to file a correction
     * for the overtime they already filed a request for.
     *
     * Approved only. A pending request is a proposal, and treating it as
     * authorisation would let anyone silence the prompt by asking.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select("overtime_minutes")
      .eq("requester_id", userId)
      .eq("request_type", "OVERTIME")
      .eq("status", "APPROVED")
      .eq("work_date", today),
    loadAppSettings(),
  ]);

  const rows = entries.data ?? [];
  const todayRow = rows.find((row) => row.work_date === today) ?? null;
  const yesterdayRow = rows.find((row) => row.work_date === yesterday) ?? null;

  // Summed, not "the first one": a day can carry more than one approved
  // overtime request, and taking one of them would under-extend the day.
  const approvedOvertimeMinutes = (overtime.data ?? []).reduce(
    (total, row) => total + (row.overtime_minutes ?? 0),
    0,
  );

  return {
    today: todayRow
      ? { work_date: todayRow.work_date, time_in: todayRow.time_in, time_out: todayRow.time_out }
      : { work_date: today, time_in: null, time_out: null },
    // Open means timed in and not out. A day with neither is not an unfinished
    // shift, it is a day off — offering to "close" it would write a time-out
    // with no time-in, which the punch function refuses anyway.
    openYesterday:
      yesterdayRow?.time_in && !yesterdayRow.time_out
        ? { work_date: yesterdayRow.work_date, time_in: yesterdayRow.time_in }
        : null,
    schedule: scheduleFor(profile.data ?? {}),
    graceMinutes: settings.graceMinutes,
    approvedOvertimeMinutes,
  };
});

/**
 * P8-12 — is today a day this person is expected to work at all?
 *
 * ⚠️ SEPARATE FROM `loadPunchState`, AND THAT SEPARATION IS THE POINT. These
 * two reads were briefly folded into it, which put them on `/`, `/dashboard`
 * and `/dtr` — three pages that call it for the punch panel and have no use for
 * the answer. The panel never reads this: the DTR records a Saturday shift
 * perfectly happily, and whether to NAG somebody about a punch is a different
 * question from whether to accept one.
 *
 * The only caller is the clock reminder, which runs in the browser after paint.
 *
 * Two reads because the answer has two independent halves, and neither is
 * knowable in the browser: `vizserve_pms_is_working_day` covers the weekend and
 * the proclaimed holiday list (P7-33), and the second covers this person's own
 * approved absence.
 *
 * FALSE ON ANY DOUBT, which is the opposite of how most flags in this file are
 * read and the right way round for this one. A failed RPC — the function
 * missing, an RLS refusal, a network fault — should produce silence rather than
 * a nudge on a public holiday.
 */
export const loadWorkingDay = cache(async (userId: string): Promise<boolean> => {
  const today = todayInAppZone();
  const supabase = await createClient();

  const [workingDay, leaveToday] = await Promise.all([
    /*
     * The RPC rather than `isBusinessDay` from lib/dates, which carries a
     * seeded 2026 list and says so — a holiday an admin added this year would
     * be missing from it. This is the same function the leave arithmetic and
     * the timesheet's weekly target consult, so all three agree by construction
     * about whether Good Friday is a working day.
     */
    supabase.rpc("vizserve_pms_is_working_day", { p_date: today }),

    /*
     * Approved leave covering today. The same overlap test the DTR page uses,
     * `start_date <= today <= end_date`.
     *
     * ⚠️ A HALF DAY SILENCES IT TOO, and the halves are deliberately not read.
     * Morning leave means arriving at midday, so the 09:00 reminder would be
     * wrong; afternoon leave means leaving at midday, so the 18:00 one would
     * be. The schedule this reminder is built on describes an ordinary day, and
     * a day with approved leave on it is not one — the DTR takes the same line,
     * refusing to compute a deviation on any day somebody was approved to be
     * away rather than trying to shift the times.
     *
     * `head: true` with an exact count: nothing here needs the rows.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id", { count: "exact", head: true })
      .eq("requester_id", userId)
      .eq("request_type", "LEAVE")
      .eq("status", "APPROVED")
      .lte("start_date", today)
      .gte("end_date", today),
  ]);

  // `data === true` rather than a truthiness test: the RPC returns `null` on
  // error, and `null` is not "yes".
  return workingDay.data === true && (leaveToday.count ?? 0) === 0;
});

import "server-only";

import type { DayHalf, LeaveSpan } from "@/lib/leave";
import { loadAppSettings } from "@/lib/settings-server";
import { resolveScheduledWeek, type ScheduledWeek } from "@/lib/timesheet-schedule";
import { createClient } from "@/utils/supabase/server";

/**
 * P8-05 — the four reads behind "this week is short of your schedule".
 *
 * THE QUERIES AND NOTHING ELSE. Every rule about what the numbers mean, and
 * every case where refusing to answer is the correct answer, lives in
 * `lib/timesheet-schedule.ts` — pure, and unit-tested without a database. Same
 * division `lib/pending-requests-server.ts` and `lib/dtr-server.ts` follow.
 *
 * TWO CALLERS, ONE IMPLEMENTATION: `/timesheet` (the shortfall line above the
 * grid) and `/dashboard` (the strip's "22h of …"). The strip used to compute
 * `STANDARD_DAY_MINUTES * 5` and show everybody a 40-hour week that this repo
 * has never defined. A third copy of this rule is how the two screens start
 * disagreeing about the same person's week.
 *
 * ⚠️ CALL IT FROM INSIDE THE CALLER'S `Promise.all`, not before it. The promise
 * starts eagerly, so its four reads run alongside the page's own — awaiting it
 * first would add a round trip to two of the busiest pages in the app.
 *
 * `createClient()` rather than a client passed in, so the shape matches
 * `loadPunchState` and neither caller has to think about it. The settings read
 * inside is `cache()`d, so a page that also renders the punch panel pays once.
 */
export async function loadScheduledWeek(userId: string, days: string[]): Promise<ScheduledWeek> {
  const monday = days[0] ?? "";
  const lastDay = days[days.length - 1] ?? monday;

  const supabase = await createClient();

  const [profileResult, holidaysResult, leaveResult, settings] = await Promise.all([
    /*
     * The person's own schedule and their unpaid break.
     *
     * `break_minutes` is NULLABLE AND NULL MEANS "INHERIT THE COMPANY FIGURE",
     * never zero. Resolving it needs both rows and therefore happens in
     * `resolveScheduledWeek`, where both are in hand.
     */
    supabase
      .from("vizserve_pms_users")
      .select("work_start, work_end, break_minutes")
      .eq("id", userId)
      .maybeSingle(),

    /*
     * The proclaimed holidays inside this week. Read from the TABLE, not from
     * `isBusinessDay` in lib/dates — that helper carries a seeded 2026 list and
     * says so, and a holiday an admin added would be missing from it. The
     * database counts expected days through `vizserve_pms_is_working_day`, which
     * reads this table, so this is the only reading that agrees with it.
     */
    supabase
      .from("vizserve_pms_holidays")
      .select("holiday_date")
      .gte("holiday_date", monday)
      .lte("holiday_date", lastDay),

    /*
     * Approved leave OVERLAPPING the week, not contained by it — leave running
     * Thursday to next Tuesday reduces what is expected of both weeks.
     *
     * The halves come along because `expandLeaveDays` needs them, and expanding
     * span → days is also what keeps the clipping right: a half-day marker
     * belongs to the request's own end, so a span that runs out of this week is
     * simply whole on every day inside it. Nothing is clipped, so nothing can
     * carry a marker across a clip.
     *
     * `requester_id` narrows a policy result rather than replacing one — a lead
     * can read their team's requests, and this figure is first-person.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select("requester_id, start_date, end_date, start_half, end_half")
      .eq("requester_id", userId)
      .eq("request_type", "LEAVE")
      .eq("status", "APPROVED")
      .lte("start_date", lastDay)
      .gte("end_date", monday),

    // `cache()`d. Degrades to the column default rather than throwing, and says
    // so through `fellBack` — which is the only thing this reader trusts it for.
    loadAppSettings(),
  ]);

  // `user_id` rather than `requester_id`, and `type_name: null` because the type
  // is not read here — `expandLeaveDays` keys days by person, and this figure has
  // exactly one. The name is what the DTR's export needs; a shortfall sentence
  // has no room for it and no reason to say it.
  const leave: LeaveSpan[] = (leaveResult.data ?? [])
    .filter((row) => row.start_date !== null && row.end_date !== null)
    .map((row) => ({
      user_id: row.requester_id,
      start_date: row.start_date!,
      end_date: row.end_date!,
      start_half: row.start_half as DayHalf | null,
      end_half: row.end_half as DayHalf | null,
      type_name: null,
    }));

  return resolveScheduledWeek({
    userId,
    days,
    profile: profileResult.data ?? null,
    profileError: Boolean(profileResult.error),
    holidays: (holidaysResult.data ?? []).map((row) => row.holiday_date),
    holidaysError: Boolean(holidaysResult.error),
    leave,
    leaveError: Boolean(leaveResult.error),
    companyBreakMinutes: settings.breakMinutes,
    settingsFellBack: settings.fellBack,
  });
}

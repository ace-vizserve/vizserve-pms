import "server-only";

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
 */
export async function loadPunchState(userId: string): Promise<PunchState> {
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
}

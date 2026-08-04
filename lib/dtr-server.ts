import "server-only";

import { todayInAppZone, yesterdayInAppZone } from "@/lib/dates";
import type { PunchState } from "@/app/(app)/dtr/punch-panel";
import { createClient } from "@/utils/supabase/server";

/**
 * Today's DTR row plus yesterday's, if yesterday was left open.
 *
 * Shared by the dashboard shortcut (P5-03) and the DTR page (P5-04) so the two
 * cannot disagree about whether you are clocked in — which they would within a
 * week if each ran its own query.
 *
 * Both days come back in ONE round trip. The yesterday half is only ever needed
 * to decide whether to offer the overnight time-out, so a second query for a
 * value that is null on almost every load is not worth the latency.
 */
export async function loadPunchState(userId: string): Promise<PunchState> {
  const today = todayInAppZone();
  const yesterday = yesterdayInAppZone();

  const supabase = await createClient();
  const { data } = await supabase
    .from("vizserve_pms_dtr_entries")
    .select("work_date, time_in, time_out")
    .eq("user_id", userId)
    .in("work_date", [today, yesterday]);

  const rows = data ?? [];
  const todayRow = rows.find((row) => row.work_date === today) ?? null;
  const yesterdayRow = rows.find((row) => row.work_date === yesterday) ?? null;

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
  };
}

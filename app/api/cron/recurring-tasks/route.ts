import { NextResponse } from "next/server";

import { isDateOnly, todayInAppZone } from "@/lib/dates";
import { cronFailure, isCronAuthorized } from "@/lib/oversight-digest-server";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P15-10 — make this period's copy of every recurring task.
 *
 * Scheduled at 16:05 UTC in `vercel.json`, which is 00:05 in Manila — the date
 * below is Manila's, so it is already the new day there. Daily runs make daily
 * copies on working days, weekly ones on Mondays and monthly ones on the 1st;
 * on any other day the function finds nothing due and makes nothing.
 *
 * ⚠️ ALL THE LOGIC IS `vizserve_pms_generate_recurring_tasks`, and it is
 * idempotent by a unique index: running this twice, or by hand after the
 * schedule, makes no second copy. A missed day makes only the current period's
 * copy when it next runs — never a backlog.
 *
 * TESTING: `?date=YYYY-MM-DD` runs it as if that were today. It WRITES —
 * there is no preview, because a preview of "create these tasks" is the list
 * of recurring tasks, which the app already shows.
 */

export const maxDuration = 60;

const TAG = "recurring-tasks";

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const requested = new URL(request.url).searchParams.get("date");
  const today = isDateOnly(requested) ? requested : todayInAppZone();

  const { data, error } = await createAdminClient().rpc("vizserve_pms_generate_recurring_tasks", {
    p_today: today,
  });

  if (error) return cronFailure(TAG, "generate", error.message);

  const made = data ?? [];
  return NextResponse.json({
    ok: true,
    date: today,
    created: made.length,
    closed: made.reduce((total, row) => total + row.closed_count, 0),
    tasks: made.map((row) => row.task_id),
  });
}

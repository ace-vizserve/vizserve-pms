import "server-only";

import { cache } from "react";

import { DEFAULT_BREAK_MINUTES, DEFAULT_GRACE_MINUTES } from "@/lib/dtr-schedule";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-37 — the company-wide settings row.
 *
 * `cache()`d for the same reason `resolveAuth` is: three screens render the
 * punch panel (`/`, `/dashboard`, `/dtr`) and the DTR table reads it again for
 * every row it judges. One read per request, shared.
 *
 * ⚠️ FALLS BACK RATHER THAN THROWING, and the fallback is the same number the
 * migration defaults the column to. A settings read that fails — RLS wobble,
 * the row deleted by someone with a SQL console, the migration not yet applied —
 * must not take out the DTR, the dashboard and the home page, because the
 * feature it powers is an advisory prompt. Degrading to five minutes is wrong
 * only if somebody deliberately changed it, and the visible symptom is a nudge
 * that fires five minutes off, not a broken screen.
 *
 * The duplicated default is deliberate and is the only place it is repeated.
 * `DEFAULT_GRACE_MINUTES` and the column default must agree; if that pair ever
 * drifts, the migration wins and this is the line to fix.
 *
 * P8-05 adds `breakMinutes` on exactly the same terms, and its fallback matters
 * rather more than the grace period's because it feeds a REFUSAL rather than a
 * nudge: `vizserve_pms_submit_timesheet_week` computes the scheduled week from
 * the same figure, so a screen reading 60 while the database reads something
 * else would tell somebody their week was fine and then refuse it. The database
 * is the authority; this number is what the screen says while it agrees.
 */
export type AppSettings = {
  graceMinutes: number;
  /**
   * The company-wide unpaid break. A person's own override lives on their user
   * row and is NOT resolved here — this reader cannot see who is asking, and
   * `null` (inherit) and `0` (no break) must not be collapsed on the way past.
   */
  breakMinutes: number;
  /**
   * P8-05 — TRUE WHEN THE NUMBERS ABOVE ARE THE DEFAULTS RATHER THAN THE ROW.
   *
   * The degrade above is deliberate and stays: a caller that only NUDGES (the
   * punch panel's grace period, the DTR's late marker) wants the fallback and
   * should never break over a settings read. But a caller that turns the break
   * into a THRESHOLD it shows somebody — "you are 2h short of your week" — is
   * asserting a figure, and asserting one derived from a value that was never
   * read is how the screen ends up accusing a person of under-logging a week
   * `vizserve_pms_submit_timesheet_week` would accept without a murmur. A
   * company break of 30 read as the fallback 60 makes the minimum 2.5h a day
   * too LOW, and the bar stays quiet while the database refuses the submission
   * with a figure the screen never mentioned.
   *
   * So the fallback is reported rather than removed. Callers that nudge ignore
   * this flag, exactly as they did before it existed; the one caller that
   * accuses withholds the whole claim when it is set.
   */
  fellBack: boolean;
};

export const loadAppSettings = cache(async (): Promise<AppSettings> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("vizserve_pms_app_settings")
    .select("grace_minutes, break_minutes")
    .maybeSingle();

  return {
    graceMinutes: data?.grace_minutes ?? DEFAULT_GRACE_MINUTES,
    breakMinutes: data?.break_minutes ?? DEFAULT_BREAK_MINUTES,
    // A missing ROW counts as a fallback just as much as a failed read does:
    // `maybeSingle` reports no error for zero rows, so testing `error` alone
    // would call the singleton's disappearance a successful read of 60.
    fellBack: Boolean(error) || !data,
  };
});

import "server-only";

import { cache } from "react";

import { DEFAULT_GRACE_MINUTES } from "@/lib/dtr-schedule";
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
 */
export type AppSettings = {
  graceMinutes: number;
};

export const loadAppSettings = cache(async (): Promise<AppSettings> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vizserve_pms_app_settings")
    .select("grace_minutes")
    .maybeSingle();

  return { graceMinutes: data?.grace_minutes ?? DEFAULT_GRACE_MINUTES };
});

import type { SupabaseClient } from "@supabase/supabase-js";

import { todayInAppZone } from "@/lib/dates";
import type { Database } from "@/lib/database.types";

/**
 * P17-10 — an internal form's deadline, `closes_on`: the last day it takes an
 * answer, in app time. The INSERT policy is what closes the form; this is what
 * lets the screens say so first.
 */

/** Open through the whole of its last day. No deadline means it stays open. */
export function isFormClosed(
  closesOn: string | null | undefined,
  today: string = todayInAppZone(),
): boolean {
  return Boolean(closesOn) && (closesOn as string) < today;
}

/**
 * The deadlines of these forms, or null when they could not be read.
 *
 * ⚠️ ITS OWN QUERY, NOT A COLUMN ON THE CALLER'S SELECT. The column is not there
 * until the migration is pasted by hand, after the deploy, and adding it to those
 * selects would take /respond and the builder down for that whole window. Here the
 * failure costs only the deadline. Nothing is lost by treating it as "no deadline":
 * once the column exists this read works, and the policy is what enforces it.
 */
export async function readFormDeadlines(
  supabase: SupabaseClient<Database>,
  formIds: string[],
): Promise<Map<string, string | null> | null> {
  if (formIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("vizserve_pms_forms")
    .select("id, closes_on")
    .in("id", formIds);

  if (error) return null;

  return new Map((data ?? []).map((row) => [row.id, row.closes_on]));
}

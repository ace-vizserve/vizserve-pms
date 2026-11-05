import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

export type FormExtras = { accepts_external: boolean; default_pic_id: string | null };

/**
 * P17-15 — the two settings the migration adds. Its own query, for the reason
 * `readFormDeadlines` gives: added to the callers' selects, these columns would take
 * the lists and the builder down until the file is pasted. Null means not there yet,
 * and the screens then hide the controls.
 */
export async function readFormExtras(
  supabase: SupabaseClient<Database>,
  formIds: string[],
): Promise<Map<string, FormExtras> | null> {
  if (formIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("vizserve_pms_forms")
    .select("id, accepts_external, default_pic_id")
    .in("id", formIds);

  if (error) return null;

  return new Map((data ?? []).map((row) => [row.id, { accepts_external: row.accepts_external, default_pic_id: row.default_pic_id }]));
}

"use client";

import { readableError, type ActionResult } from "@/lib/action-result";
import { browserClient } from "@/lib/query/browser-client";

/**
 * P12 Phase B — read receipts, browser → Supabase.
 *
 * The same updates `actions.ts` made. "notifications update own" is
 * `user_id = auth.uid()`, so neither can touch anybody else's row — and, as
 * before, no `.eq("user_id", …)` is restated, because that would imply the
 * policy were optional. Both only ever stamp `read_at` where it is null, so
 * re-opening something read last week does not move its timestamp.
 */
export async function markNotificationRead(id: string): Promise<ActionResult<null>> {
  const { error } = await browserClient()
    .from("vizserve_pms_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: null };
}

export async function markAllNotificationsRead(): Promise<ActionResult<null>> {
  const { error } = await browserClient()
    .from("vizserve_pms_notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: null };
}

"use client";

import { flattenIssues, readableError, type ActionResult } from "@/lib/action-result";
import { browserClient } from "@/lib/query/browser-client";
import { punchSchema, type PunchResult } from "@/lib/schemas/dtr";

/**
 * P12 Phase B — the punch, browser → Supabase.
 *
 * The same call `actions.ts` made: `vizserve_pms_punch` owns earliest-in /
 * latest-out, the today-or-yesterday window and the 18-hour cut-off, acts on
 * `auth.uid()` alone, and can IGNORE a press (`captured: false`) — so the panel
 * still shows only what it returns. Nothing moved but the round trip through a
 * Next function. The CSV export stays a server action: it assembles a file.
 */
export async function punch(input: unknown): Promise<ActionResult<PunchResult>> {
  const parsed = punchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the form.", fieldErrors: flattenIssues(parsed.error) };
  }

  const { data, error } = await browserClient().rpc("vizserve_pms_punch", {
    p_direction: parsed.data.direction,
    p_work_date: parsed.data.direction === "out" ? (parsed.data.work_date ?? null) : null,
  });

  if (error) return { ok: false, error: readableError(error) };
  return { ok: true, data: data as unknown as PunchResult };
}

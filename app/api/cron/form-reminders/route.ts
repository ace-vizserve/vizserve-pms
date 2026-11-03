import { NextResponse } from "next/server";

import { cronFailure, isCronAuthorized } from "@/lib/oversight-digest-server";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P17-10 — tell people about an internal form: once when it is published, then
 * three days before its deadline and the day before.
 *
 * Who is told and what it says are all in `vizserve_pms_send_form_reminders`. It
 * writes notifications, and `dispatch-emails` sends them on its own schedule.
 * Hourly so a new form is announced soon after publishing; the function stays
 * quiet outside 08:00–18:59 Manila.
 */

export const maxDuration = 60;

const TAG = "form-reminders";

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { data, error } = await createAdminClient().rpc("vizserve_pms_send_form_reminders");
  if (error) return cronFailure(TAG, "send", error.message);

  return NextResponse.json({ ok: true, summary: data });
}

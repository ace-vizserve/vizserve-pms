import { NextResponse } from "next/server";
import { z } from "zod";

import { recordError } from "@/lib/error-log-server";
import { LIMITS } from "@/lib/error-log";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

/**
 * P17-05 — a browser error, reported by the error pages.
 *
 * Only for errors that never reached the server: a server error already has a
 * row from `instrumentation.ts`, and the error pages skip anything carrying a
 * digest for exactly that reason.
 *
 * SIGNED IN ONLY. The proxy turns a signed-out request away before it gets
 * here, and the session is checked again below — the public client pages have
 * no session, and an open endpoint that writes to the database is a gift to
 * anyone with a loop.
 *
 * ⚠️ 20 A MINUTE PER PERSON, then dropped. An error inside a render loop
 * reports itself every frame; the first twenty say everything the next
 * thousand would.
 */

const reportSchema = z.object({
  message: z.string().min(1).max(LIMITS.message * 2),
  stack: z.string().max(LIMITS.stack * 2).nullish(),
  path: z.string().max(LIMITS.path * 2).nullish(),
  boundary: z.string().max(40).nullish(),
});

const PER_MINUTE = 20;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null;
  if (!userId) return new NextResponse(null, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await createAdminClient()
    .from("vizserve_pms_error_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("occurred_at", since);
  if ((count ?? 0) >= PER_MINUTE) return new NextResponse(null, { status: 202 });

  await recordError({
    source: "client",
    kind: "client",
    path: parsed.data.path,
    route: parsed.data.boundary ? `error boundary: ${parsed.data.boundary}` : null,
    message: parsed.data.message,
    stack: parsed.data.stack,
    user_id: userId,
    user_agent: request.headers.get("user-agent"),
  });

  return new NextResponse(null, { status: 204 });
}

import "server-only";

import { createServerClient, parseCookieHeader } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";
import { currentEnvironment, shouldRecord, toErrorRow, type ErrorReport } from "@/lib/error-log";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P17-05 — writing a row to the error log.
 *
 * ⚠️ IT NEVER THROWS. It runs while something has already gone wrong; a
 * reporter that can fail turns one error into two and can hide the first. Any
 * failure here — the table not applied yet, the network — is a console line
 * and nothing more.
 *
 * The service role, deliberately: nobody holds INSERT on this table (see the
 * migration), so a signed-in person cannot write fake errors into it through
 * PostgREST. The two callers decide what is worth recording; this only stores.
 */
export async function recordError(report: Omit<ErrorReport, "environment">): Promise<void> {
  if (!shouldRecord()) return;
  try {
    const { error } = await createAdminClient()
      .from("vizserve_pms_error_logs")
      .insert(toErrorRow({ ...report, environment: currentEnvironment() }));
    if (error) console.error("[error-log] could not record:", error.message);
  } catch (caught) {
    console.error("[error-log] could not record:", caught);
  }
}

/**
 * Who was signed in, read from the request's own cookies.
 *
 * `onRequestError` runs outside the request scope `cookies()` needs, so the
 * cookie header is parsed by hand and handed to an ordinary session client.
 * `getClaims()` verifies the token locally — no network call on the way to
 * recording a failure. Null for anyone signed out, and on any doubt.
 */
export async function userIdFromCookieHeader(header: string | undefined): Promise<string | null> {
  if (!header) return null;
  try {
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll: () => parseCookieHeader(header).map(({ name, value }) => ({ name, value: value ?? "" })),
          // Read-only: there is no response here to set a refreshed cookie on.
          setAll: () => {},
        },
      },
    );
    const { data } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

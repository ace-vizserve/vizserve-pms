import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * Service-role client. BYPASSES RLS ENTIRELY.
 *
 * Legitimate uses are narrow and all server-side:
 *   - seeding (P0-12)
 *   - the public form submission path, which has no session to scope by (P1-07)
 *   - the auto-complete cron job, which acts as the system (P4-09)
 *
 * Never call this in response to a user action without first establishing that
 * user's authority through `lib/auth/authorization.ts`. Reaching for it because
 * a query "returned nothing" is how the RLS layer quietly stops being real.
 */
export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set. It is required for admin/service-role operations.",
    );
  }

  return createSupabaseClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

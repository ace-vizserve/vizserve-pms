import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

/**
 * Browser Supabase client. Carries the user's session, so every query it makes
 * is subject to RLS — which is the point. The app is never the only thing
 * checking scope (docs/02-data-model.md §RLS strategy).
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}

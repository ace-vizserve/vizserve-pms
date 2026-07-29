import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/database.types";

/**
 * Server Supabase client, scoped to the caller's session.
 *
 * Use this in Server Components, Server Actions and Route Handlers. It respects
 * RLS. If you need to bypass RLS, that is `utils/supabase/admin.ts` and it needs
 * a reason.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, which cannot set cookies. Safe to
            // ignore: middleware refreshes the session on every request.
          }
        },
      },
    },
  );
}

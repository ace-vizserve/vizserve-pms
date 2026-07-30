import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";

/** Paths reachable with no session at all, matched as prefixes. */
const PUBLIC_PREFIXES = [
  "/login",
  "/auth",
  "/f/", // public client forms (P1-06) — no login, by design
  "/approve/", // client approval page (Phase 4) — token-authenticated, no session
];

/**
 * Public paths matched EXACTLY.
 *
 * "/" cannot go in PUBLIC_PREFIXES: the check below is a `startsWith`, and
 * every path starts with "/", so adding it there would make the entire
 * authenticated app anonymously reachable. Anything rooted at "/" belongs
 * here instead.
 */
const PUBLIC_EXACT = new Set([
  "/", // marketing landing page
]);

export function isPublicPath(pathname: string) {
  if (PUBLIC_EXACT.has(pathname)) return true;

  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix),
  );
}

/**
 * Refreshes the auth session on every request and gates the authenticated area.
 *
 * NOTE ON `user_metadata`: the app-access claim read here is a routing
 * convenience only. It is user-writable through Supabase's own GoTrue endpoint,
 * so it is never the answer to "may this person do this" — that is
 * `lib/auth/authorization.ts` reading `vizserve_pms_users.role`, plus RLS.
 * See docs/02-data-model.md §Auth metadata.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and getUser() — a stray await
  // here makes sessions randomly terminate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

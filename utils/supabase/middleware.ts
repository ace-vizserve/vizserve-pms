import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";

/**
 * Paths reachable with no session at all, matched as prefixes.
 *
 * Every one is a deliberate hole in the only thing standing between the internet
 * and the authenticated area, and each authenticates by some other means — a
 * token in the URL, or a bearer secret. Adding one is a decision.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/auth",
  "/request/", // public client forms (P1-06 / P7-29) — no login, by design
  // ⚠️ THE OLD ADDRESS STAYS PUBLIC. `/f/[slug]` is a permanent redirect to
  // `/request/[slug]` now, and a redirect behind the gate is worse than no
  // redirect: an old link in a client's inbox would ask somebody with no
  // account to sign in rather than forwarding them.
  "/f/",
  "/approve/", // client approval page (P4-04) — token-authenticated
  "/feedback/", // client feedback page (P4-10) — same token machinery
  // P7-51. The tracking page the acknowledgement links to. Same posture as the
  // three above: no login, an unguessable token in the URL, and the only route
  // into the data is a SECURITY DEFINER function that projects safe columns.
  "/status/",
  // Cron routes carry `Authorization: Bearer $CRON_SECRET` and no cookie.
  // Without this they redirect to /login, and Vercel's scheduler would follow
  // the 307 and report a cheerful 200 — so the jobs would silently never run.
  // Each route re-checks the secret itself and 404s without it.
  "/api/cron/",
];

/**
 * Public paths matched EXACTLY.
 *
 * "/" cannot go in PUBLIC_PREFIXES: the check below is a `startsWith`, and
 * every path starts with "/", so adding it there would make the entire
 * authenticated app anonymously reachable. Anything rooted at "/" belongs
 * here instead.
 *
 * THE SET IS EMPTY, and that is the point. "/" used to be a public marketing
 * page arguing for the product. It is a staff home now — this platform is for
 * people who already work here, and nobody who does needs to be sold it — so
 * the root is gated like everything else and an anonymous visitor is sent to
 * sign in. The pages a CLIENT sees are `/request/[slug]`, `/approve/[token]` and
 * `/feedback/[token]`, which are prefixes below and reach the database only
 * through SECURITY DEFINER functions.
 */
const PUBLIC_EXACT = new Set<string>();

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
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

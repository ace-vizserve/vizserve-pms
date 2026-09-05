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

  /*
   * Do not run code between createServerClient and this call — a stray await
   * here makes sessions randomly terminate.
   *
   * ⚠️ `getClaims()`, NOT `getUser()`, AND THE DIFFERENCE IS A NETWORK ROUND
   * TRIP ON EVERY SINGLE REQUEST.
   *
   * `getUser()` asks the Auth server to resolve the token — measured against
   * this project at 160–400 ms. The matcher in `proxy.ts` covers everything
   * except static assets, so that cost was paid on every navigation, every
   * Server Action and every cron ping, BEFORE any page began its own queries.
   * `resolveAuth` then paid it a second time on the render.
   *
   * `getClaims()` verifies the JWT signature locally with WebCrypto against the
   * project's published JWKS, so the same answer costs no request at all. It is
   * not a weaker check: Supabase's own guidance is that `getClaims()` is safe to
   * trust precisely because it validates the signature every time — unlike
   * `getSession()`, which reads the cookie and believes it, and which is why
   * this file has never used it.
   *
   * ⚠️ THE LOCAL PATH REQUIRES ASYMMETRIC SIGNING KEYS. This project publishes
   * one ES256 key at `/auth/v1/.well-known/jwks.json` (checked 5 Sep 2026). If
   * it is ever moved back to a symmetric secret, `getClaims()` silently starts
   * sending a `getUser()`-shaped request instead — correct, but the saving is
   * gone and nothing here would say so.
   *
   * The session refresh this middleware exists for is unaffected: `getClaims()`
   * refreshes an access token that is about to expire before validating it, so
   * `setAll` above still writes the rotated cookies.
   */
  const { data: claims } = await supabase.auth.getClaims();

  // `sub` is the user id. Named `user` so the two gates below read exactly as
  // they did — this change is about what the answer COSTS, not what it is.
  const user = claims?.claims.sub ?? null;

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

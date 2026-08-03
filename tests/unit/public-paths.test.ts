import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The auth gate's allow-list.
 *
 * Every entry is a deliberate hole in the only thing standing between the
 * internet and the authenticated area, so the list is pinned rather than left to
 * whoever edits it next. This test fails on ANY change — including a correct
 * one — which is the point: adding a public path should require saying so.
 *
 * Read as source text rather than imported, because the module pulls in
 * `next/server` and a session client; neither is needed to check a list of
 * strings, and both make the test fragile for no benefit.
 */

const SOURCE = readFileSync("utils/supabase/middleware.ts", "utf8");

/** Exactly the prefixes that may bypass the session check. */
const EXPECTED = ["/login", "/auth", "/f/", "/approve/", "/feedback/", "/api/cron/"];

function declaredPrefixes(): string[] {
  const block = /const PUBLIC_PREFIXES = \[([\s\S]*?)\];/.exec(SOURCE);
  if (!block) throw new Error("PUBLIC_PREFIXES has moved or been renamed.");

  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("the auth gate allow-list", () => {
  it("contains exactly the paths that are meant to be public", () => {
    expect(declaredPrefixes()).toEqual(EXPECTED);
  });

  it("still covers the two client-facing surfaces", () => {
    const prefixes = declaredPrefixes();

    // A client has no account by design. If either of these stops being public
    // the whole of Phase 4 breaks — and it breaks as a redirect to a login page
    // the client cannot use, not as an error anyone here would notice.
    expect(prefixes).toContain("/approve/");
    expect(prefixes).toContain("/feedback/");
    // The public form (P1-06) — same reasoning, one phase earlier.
    expect(prefixes).toContain("/f/");
  });

  it("still covers the cron routes", () => {
    // These carry a bearer secret and no cookie. Without the entry they redirect
    // to /login, and Vercel's scheduler follows the 307 and reports 200 — so
    // auto-completion and the email outbox would silently never run while every
    // dashboard said the jobs were fine.
    expect(declaredPrefixes()).toContain("/api/cron/");
  });

  it("does not expose the authenticated area", () => {
    const prefixes = declaredPrefixes();

    for (const guarded of ["/", "/dashboard", "/tasks", "/requests", "/admin", "/forms", "/inbox"]) {
      expect(prefixes, `${guarded} must not be public`).not.toContain(guarded);
    }
  });

  it("keeps every entry anchored at the start of the path", () => {
    // `isPublicPath` uses startsWith, so a prefix without a leading slash would
    // match nothing, and one without a trailing slash on a segment prefix would
    // match too much — "/f" would also open "/forms".
    for (const prefix of declaredPrefixes()) {
      expect(prefix.startsWith("/"), `${prefix} must start with /`).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";

import { isPublicPath } from "./middleware";

/**
 * The allow-list is matched with `startsWith`, which makes it one careless edit
 * away from opening the whole app: every pathname starts with "/", so a bare
 * "/" in PUBLIC_PREFIXES would return true for `/dashboard` too.
 *
 * These cases exist to fail loudly if that happens. Note that `/` itself is NOT
 * public any more — see the first case.
 */
describe("isPublicPath", () => {
  it("keeps the root behind the session gate", () => {
    /*
     * THIS ASSERTION IS REVERSED FROM WHAT IT WAS, and the reversal is the
     * decision rather than a regression.
     *
     * It read `toBe(true)` and was titled "allows the marketing landing page".
     * That page is gone: P7-10 made `/` the STAFF HOME — the day's shape, the
     * punch panel, the leave calendar — and nobody who works at VizServe is the
     * person a marketing page argues to. `PUBLIC_EXACT` was emptied to match, so
     * an anonymous visitor is sent to /login before `app/page.tsx` runs. The old
     * landing page is kept verbatim under docs/archive/landing-page/.
     *
     * The test was left asserting the old behaviour and has been failing since,
     * which is also why `npm run verify` was not green when this was found.
     *
     * It stays as a test rather than being deleted, because "/" is the one path
     * where a careless re-add to PUBLIC_EXACT would expose the staff home to
     * anyone with the URL.
     */
    expect(isPublicPath("/")).toBe(false);
  });

  it.each([
    "/dashboard",
    "/requests",
    "/requests/abc-123",
    "/forms",
    "/forms/new",
    "/inbox",
    "/admin/users",
  ])("keeps %s behind the session gate", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false);
  });

  it.each([
    "/login",
    "/auth/callback",
    "/forgot-password",
    "/request/intake-form",
    // P7-29 — the OLD address, and it has to stay public or the permanent
    // redirect that replaced it sends a client with no account to a login.
    "/f/intake-form",
    "/approve/some-token",
    // P4-10. A client has no account by design, so if this stops being public
    // the feedback page redirects them to a login they cannot use — and it
    // breaks as a redirect nobody internal would ever see.
    "/feedback/some-token",
  ])("keeps %s public", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it.each(["/api/cron/dispatch-emails", "/api/cron/client-approvals"])(
    "keeps %s reachable for the scheduler",
    (pathname) => {
      // These carry `Authorization: Bearer $CRON_SECRET` and no cookie. Behind
      // the gate they redirect to /login — and Vercel's scheduler follows the
      // 307 and reports a cheerful 200, so auto-completion and the email outbox
      // would silently never run while every dashboard said the jobs were fine.
      //
      // Public here only in the sense of "no session". Each route re-checks the
      // bearer secret itself and 404s without it.
      expect(isPublicPath(pathname)).toBe(true);
    },
  );

  it("does not open the rest of /api", () => {
    // The prefix is `/api/cron/`, not `/api/`. Worth pinning: the shorter one
    // would be an easy simplification to make and would expose every future
    // route handler.
    expect(isPublicPath("/api/tasks")).toBe(false);
    expect(isPublicPath("/api/cron-ish")).toBe(false);
  });

  it("does not treat a lookalike prefix as public", () => {
    // `/forms` shares a prefix with nothing public, but `/f/` is a public
    // prefix — the trailing slash is what stops `/forms` matching it.
    expect(isPublicPath("/forms")).toBe(false);
    expect(isPublicPath("/logout-audit")).toBe(false);
    // P7-29 added `/request/`, which is one character from the authenticated
    // `/requests` — the internal review queue, and the closest lookalike this
    // allowlist has ever had.
    expect(isPublicPath("/requests")).toBe(false);
    expect(isPublicPath("/requests/8f1c")).toBe(false);
  });
});

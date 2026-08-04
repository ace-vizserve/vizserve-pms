import { describe, expect, it } from "vitest";

import { isPublicPath } from "./middleware";

/**
 * The allow-list is matched with `startsWith`, which makes it one careless edit
 * away from opening the whole app: every pathname starts with "/", so a bare
 * "/" in PUBLIC_PREFIXES would return true for `/dashboard` too.
 *
 * These cases exist to fail loudly if that happens.
 */
describe("isPublicPath", () => {
  it("allows the marketing landing page, and only at the root", () => {
    expect(isPublicPath("/")).toBe(true);
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
  });
});

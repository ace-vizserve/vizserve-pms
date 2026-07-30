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
  ])("keeps %s public", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
  });

  it("does not treat a lookalike prefix as public", () => {
    // `/forms` shares a prefix with nothing public, but `/f/` is a public
    // prefix — the trailing slash is what stops `/forms` matching it.
    expect(isPublicPath("/forms")).toBe(false);
    expect(isPublicPath("/logout-audit")).toBe(false);
  });
});

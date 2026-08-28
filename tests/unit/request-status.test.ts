import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateStatusToken, hashStatusToken, statusUrl } from "@/lib/request-status";

/**
 * P7-51 — the tracking token behind the public status page.
 *
 * ⚠️ WHY THIS IS A TOKEN AND NOT THE REFERENCE NUMBER. `reference_no` is
 * SEQUENTIAL — VIZ-2026-0001, -0002, -0003. A page keyed on it would let anybody
 * holding one link count upwards and read every client's request. These tests
 * exist to keep the two properties that stop that: the token is unguessable, and
 * only its hash is ever stored.
 */

const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://pms.vizserve.com";
});

afterEach(() => {
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

describe("generateStatusToken", () => {
  it("is long enough to be unguessable", () => {
    // 32 random bytes → 43 base64url characters. Well past anything a
    // rate-limited endpoint could be walked through.
    expect(generateStatusToken().length).toBeGreaterThanOrEqual(43);
  });

  it("is URL-safe with no padding", () => {
    // base64url, not base64: `+`, `/` and `=` would each need escaping, and an
    // email client's autolinker truncates at the first character it does not
    // expect — producing a link that 404s for reasons nobody can see.
    for (let i = 0; i < 50; i += 1) {
      expect(generateStatusToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateStatusToken()));
    expect(seen.size).toBe(500);
  });

  it("carries no recognisable structure", () => {
    // Deliberately NOT a uuid. A v4 uuid is recognisable on sight, and a
    // recognisable shape invites somebody to try generating one.
    expect(generateStatusToken()).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("hashStatusToken", () => {
  it("is a hex sha-256", () => {
    expect(hashStatusToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the value Postgres computes", () => {
    /*
     * THE LOAD-BEARING ASSERTION. The migration looks the token up with
     * `encode(digest(p_token, 'sha256'), 'hex')`. If this implementation ever
     * drifts from that — a different encoding, a salt, a trim — every tracking
     * link silently stops resolving and the page says "not valid" for tokens
     * that are perfectly good.
     *
     * This is the published SHA-256 of "abc", so it pins the algorithm rather
     * than merely pinning this function against itself.
     */
    expect(hashStatusToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is stable and differs per token", () => {
    const token = generateStatusToken();
    expect(hashStatusToken(token)).toBe(hashStatusToken(token));
    expect(hashStatusToken(token)).not.toBe(hashStatusToken(generateStatusToken()));
  });

  it("never returns the token itself", () => {
    // The whole point: a dump of the column must yield nothing replayable.
    const token = generateStatusToken();
    expect(hashStatusToken(token)).not.toContain(token);
  });
});

describe("statusUrl", () => {
  it("is absolute, because it is read in a mail client", () => {
    expect(statusUrl("abc123")).toBe("https://pms.vizserve.com/status/abc123");
  });

  it("does not double the slash on a trailing-slash origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://pms.vizserve.com/";
    expect(statusUrl("abc123")).toBe("https://pms.vizserve.com/status/abc123");
  });

  it("falls back to localhost rather than emitting undefined", () => {
    /*
     * A dev with no `NEXT_PUBLIC_SITE_URL` would otherwise get
     * "undefined/status/…" in the email, which reads as a bug in the template
     * rather than as a missing environment variable.
     */
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(statusUrl("abc123")).toBe("http://localhost:3000/status/abc123");
    expect(statusUrl("abc123")).not.toContain("undefined");
  });

  it("round-trips a real token unchanged", () => {
    // base64url survives a URL without escaping — this proves the generator and
    // the URL builder agree, which is what makes a pasted link work.
    const token = generateStatusToken();
    expect(statusUrl(token).endsWith(`/status/${token}`)).toBe(true);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

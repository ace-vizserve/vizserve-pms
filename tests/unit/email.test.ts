import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { absoluteUrl, escapeHtml, isDeliverable } from "@/lib/email/config";
import { renderEmail } from "@/lib/email/layout";

/**
 * P0-11 — the email safety gate.
 *
 * `isDeliverable` is the rule that stops a dev or QA run mailing a real client.
 * It is one function guarding sixteen seeded addresses, so it gets tested like
 * one.
 */

const originalAppUrl = process.env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://pms.vizserve.test";
});

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalAppUrl;
});

describe("isDeliverable — dev and staging never deliver real mail", () => {
  it("refuses every seeded test account", () => {
    // All sixteen are @example.com. If this ever returns true, a QA run is one
    // typo away from emailing an actual client.
    expect(isDeliverable("test.admin@example.com")).toBe(false);
    expect(isDeliverable("test.tl.vizbytes@example.com")).toBe(false);
  });

  it("refuses the other IANA-reserved domains too", () => {
    expect(isDeliverable("someone@example.org")).toBe(false);
    expect(isDeliverable("someone@example.net")).toBe(false);
    expect(isDeliverable("someone@localhost")).toBe(false);
    expect(isDeliverable("someone@thing.invalid")).toBe(false);
  });

  it("refuses a subdomain of a reserved domain", () => {
    // mail.example.com is just as undeliverable, and a naive equality check
    // would let it through.
    expect(isDeliverable("someone@mail.example.com")).toBe(false);
  });

  it("allows real addresses", () => {
    expect(isDeliverable("amier.vizbytes@vizserve.hfse.edu.sg")).toBe(true);
    expect(isDeliverable("client@gmail.com")).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(isDeliverable("  TEST.ADMIN@EXAMPLE.COM ")).toBe(false);
  });

  it("refuses a value with no domain rather than assuming one", () => {
    expect(isDeliverable("not-an-address")).toBe(false);
    expect(isDeliverable("")).toBe(false);
  });
});

describe("absoluteUrl", () => {
  it("makes a link path absolute — a relative path in an email links nowhere", () => {
    expect(absoluteUrl("/requests/abc")).toBe("https://pms.vizserve.test/requests/abc");
  });

  it("does not double the slash", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://pms.vizserve.test/";
    expect(absoluteUrl("/inbox")).toBe("https://pms.vizserve.test/inbox");
  });

  it("leaves an already-absolute URL alone", () => {
    expect(absoluteUrl("https://elsewhere.test/x")).toBe("https://elsewhere.test/x");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in attacker-influenced text", () => {
    // Request titles come off a public, unauthenticated form. Unescaped, a
    // submitted title rewrites the email a Team Leader reads.
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands first, so entities are not double-broken", () => {
    expect(escapeHtml("Tom & Jerry <b>")).toBe("Tom &amp; Jerry &lt;b&gt;");
  });
});

describe("renderEmail", () => {
  it("produces both an HTML and a plain-text part", () => {
    // A message with no text/plain part scores worse with spam filters, and
    // Phase 4 rests entirely on one email reaching one client's inbox.
    const { html, text } = renderEmail({
      preheader: "COL-2026-0142",
      heading: "Approval needed",
      paragraphs: ["Hi Ryza,", "A new request is waiting."],
      facts: [{ label: "Target date", value: "5 Aug 2026" }],
      button: { label: "Review the request", path: "/requests/abc" },
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("https://pms.vizserve.test/requests/abc");
    expect(text).toContain("Review the request: https://pms.vizserve.test/requests/abc");
    expect(text).not.toContain("<");
  });

  it("escapes every interpolated value, including the quote block", () => {
    const { html } = renderEmail({
      preheader: "x",
      heading: "<img src=x onerror=alert(1)>",
      paragraphs: ["<b>bold</b>"],
      quote: { label: "Reason", text: "<script>bad</script>" },
    });

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad");
    expect(html).toContain("&lt;script&gt;bad");
  });

  it("omits the button block entirely when there is no link", () => {
    const { html, text } = renderEmail({
      preheader: "x",
      heading: "No action needed",
      paragraphs: ["FYI."],
    });

    expect(html).not.toContain("border-radius:6px;background:#4359A5");
    expect(text).not.toContain("http");
  });
});

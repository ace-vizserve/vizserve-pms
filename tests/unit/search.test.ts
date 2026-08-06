import { describe, expect, it } from "vitest";

import { ilikeAnyOf, likeContains, MAX_SEARCH_LENGTH, quoteFilterValue } from "@/lib/search";

/**
 * `lib/search.ts` builds a RAW PostgREST filter string out of whatever someone
 * types into a search box. That makes it the one place in the app where user
 * input becomes query syntax, so it gets tested like it.
 *
 * The dangerous cases are not exotic. A comma is one keystroke.
 */

describe("likeContains — LIKE metacharacters are data, not wildcards", () => {
  it("wraps a plain term in wildcards", () => {
    expect(likeContains("approval")).toBe("%approval%");
  });

  it("escapes a percent so it does not match everything", () => {
    // Without this, searching "50%" returns the entire inbox and looks like it
    // worked — the failure mode that produces confidently wrong results.
    expect(likeContains("50%")).toBe("%50\\%%");
  });

  it("escapes an underscore, which LIKE treats as any single character", () => {
    expect(likeContains("no_time_in")).toBe("%no\\_time\\_in%");
  });

  it("escapes a backslash without doubling the escapes it adds itself", () => {
    // The ordering trap: escaping % first and \ second would turn "%" into
    // "\\%", which matches a literal backslash followed by any string.
    expect(likeContains("a\\b")).toBe("%a\\\\b%");
    expect(likeContains("a\\%b")).toBe("%a\\\\\\%b%");
  });
});

describe("quoteFilterValue — commas and quotes stay inside one filter", () => {
  it("quotes a plain value", () => {
    expect(quoteFilterValue("%foo%")).toBe('"%foo%"');
  });

  it("escapes an embedded double quote", () => {
    expect(quoteFilterValue('a"b')).toBe('"a\\"b"');
  });

  it("escapes a backslash", () => {
    expect(quoteFilterValue("a\\b")).toBe('"a\\\\b"');
  });
});

describe("ilikeAnyOf — the composed filter", () => {
  it("builds one clause per column", () => {
    expect(ilikeAnyOf(["title", "body"], "poster")).toBe(
      'title.ilike."%poster%",body.ilike."%poster%"',
    );
  });

  it("keeps a comma inside the quoted value rather than splitting the filter", () => {
    // The injection case. Unquoted, this would read as three filters and 400.
    const filter = ilikeAnyOf(["title"], "a,b")!;
    expect(filter).toBe('title.ilike."%a,b%"');
    // Exactly one clause: the only comma is inside the quotes.
    expect(filter.split('",').length).toBe(1);
  });

  it("survives characters that would close the or() group", () => {
    const filter = ilikeAnyOf(["title"], "a)b(c")!;
    expect(filter).toBe('title.ilike."%a)b(c%"');
  });

  it("returns null for an empty or whitespace-only term", () => {
    // A caller must be able to skip the filter entirely. `%%` matches every row
    // and pays for a full scan to do it.
    expect(ilikeAnyOf(["title"], "")).toBeNull();
    expect(ilikeAnyOf(["title"], "   ")).toBeNull();
    expect(ilikeAnyOf(["title"], null)).toBeNull();
    expect(ilikeAnyOf(["title"], undefined)).toBeNull();
  });

  it("trims and caps an over-long term", () => {
    const filter = ilikeAnyOf(["title"], `  ${"x".repeat(500)}  `)!;
    expect(filter).toContain("x".repeat(MAX_SEARCH_LENGTH));
    expect(filter).not.toContain("x".repeat(MAX_SEARCH_LENGTH + 1));
  });
});

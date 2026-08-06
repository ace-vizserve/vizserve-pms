import { describe, expect, it } from "vitest";

import { PAGE_SIZES, pageWindow, resolvePage, resolvePageSize } from "@/components/pagination";

/**
 * The page-size clamp is a security-adjacent test, not a cosmetic one:
 * `.range()` takes whatever it is handed, so an unvalidated `?size=` is a
 * one-URL-edit path to selecting every row the caller can see in one query.
 *
 * The window arithmetic gets tested because its off-by-ones survive a visual
 * check — "…" hiding exactly one page looks plausible and is strictly worse
 * than the page it replaces.
 */

describe("resolvePageSize — only the offered sizes", () => {
  it.each(PAGE_SIZES)("accepts the offered size %i", (size) => {
    expect(resolvePageSize(String(size))).toBe(size);
  });

  // Objects rather than tuples: `why` names the case in the test output via
  // `$why`, without the callback having to accept a parameter it never uses.
  it.each([
    { raw: "100000" as string | undefined, why: "an unbounded fetch" },
    { raw: "-1" as string | undefined, why: "a negative range" },
    { raw: "0" as string | undefined, why: "an empty range" },
    { raw: "21" as string | undefined, why: "a plausible but unoffered size" },
    { raw: "abc" as string | undefined, why: "junk" },
    { raw: undefined as string | undefined, why: "nothing" },
  ])("falls back to the default for $raw ($why)", ({ raw }) => {
    expect(resolvePageSize(raw)).toBe(PAGE_SIZES[0]);
  });
});

describe("resolvePage", () => {
  it("accepts a whole page number", () => {
    expect(resolvePage("4")).toBe(4);
  });

  it.each(["0", "-4", "abc", "", undefined])("falls back to 1 for %s", (raw) => {
    // A negative page would make `from` negative, and .range(-80, -61) is not
    // an error — it is a wrong answer.
    expect(resolvePage(raw as string | undefined)).toBe(1);
  });

  it("floors a fractional page rather than passing it to .range()", () => {
    expect(resolvePage("3.7")).toBe(3);
  });
});

describe("pageWindow", () => {
  it("lists every page when there are few", () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("always includes the first and last page", () => {
    const window = pageWindow(10, 20);
    expect(window[0]).toBe(1);
    expect(window.at(-1)).toBe(20);
  });

  it("shows the current page's neighbours", () => {
    expect(pageWindow(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
  });

  it("never renders a gap that hides a single page", () => {
    // The off-by-one worth pinning: at page 4 of 20 the pages between 1 and 3
    // are just "2", and an ellipsis there is the same width as the number it
    // conceals.
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });

  it("does not duplicate the first or last page when near an end", () => {
    for (const page of [1, 2, 3, 19, 20]) {
      const window = pageWindow(page, 20);
      const numbers = window.filter((item): item is number => item !== "gap");
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it("stays sorted", () => {
    const numbers = pageWindow(10, 40).filter((item): item is number => item !== "gap");
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
  });

  it("handles a single page", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});

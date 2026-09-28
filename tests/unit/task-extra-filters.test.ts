import { describe, expect, it } from "vitest";

import { addDays, startOfWeek, todayInAppZone } from "@/lib/dates";
import {
  applyExtraFilters,
  extraFiltersKey,
  NO_EXTRA_FILTERS,
  readExtraFilters,
  type ExtraTaskFilters,
} from "@/lib/task-extra-filters";

/** Records every call a PostgREST builder would receive. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const builder = {
    ilike: (...args: unknown[]) => (calls.push(["ilike", ...args]), builder),
    lt: (...args: unknown[]) => (calls.push(["lt", ...args]), builder),
    gte: (...args: unknown[]) => (calls.push(["gte", ...args]), builder),
    lte: (...args: unknown[]) => (calls.push(["lte", ...args]), builder),
    is: (...args: unknown[]) => (calls.push(["is", ...args]), builder),
    not: (...args: unknown[]) => (calls.push(["not", ...args]), builder),
  };
  return { builder, calls };
}

const params = (values: Record<string, string>) => (key: string) => values[key] ?? null;
const ME = "11111111-1111-4111-8111-111111111111";

describe("readExtraFilters", () => {
  it("resolves ?person=me to the viewer and defaults the role to any", () => {
    expect(readExtraFilters(params({ person: "me" }), ME)).toEqual({ q: null, person: ME, role: "any", due: null });
  });

  it("ignores an unknown role or due value rather than guessing", () => {
    const read = readExtraFilters(params({ person: "x", role: "boss", due: "someday" }), ME);
    expect(read.role).toBe("any");
    expect(read.due).toBeNull();
  });

  it("trims the search and drops an empty one", () => {
    expect(readExtraFilters(params({ q: "  safari  " }), ME).q).toBe("safari");
    expect(readExtraFilters(params({ q: "   " }), ME).q).toBeNull();
  });
});

describe("extraFiltersKey", () => {
  it("leaves the role out of the cache key when no person is chosen", () => {
    expect(extraFiltersKey({ ...NO_EXTRA_FILTERS, role: "qa" })).toEqual({
      q: undefined,
      person: undefined,
      role: undefined,
      due: undefined,
    });
  });
});

describe("applyExtraFilters", () => {
  const apply = (filters: Partial<ExtraTaskFilters>) => {
    const { builder, calls } = recorder();
    applyExtraFilters(builder, { ...NO_EXTRA_FILTERS, ...filters });
    return calls;
  };

  it("does nothing with no filters", () => {
    expect(apply({})).toEqual([]);
  });

  it("searches the title, with ILIKE wildcards escaped", () => {
    expect(apply({ q: "100%_done" })).toEqual([["ilike", "title", "%100\\%\\_done%"]]);
  });

  it("overdue is before today AND not finished", () => {
    expect(apply({ due: "overdue" })).toEqual([
      ["lt", "due_date", todayInAppZone()],
      ["not", "status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)"],
    ]);
  });

  it("this week and next week are Monday-to-Sunday windows", () => {
    const monday = startOfWeek(todayInAppZone())!;
    expect(apply({ due: "this_week" })).toEqual([
      ["gte", "due_date", monday],
      ["lte", "due_date", addDays(monday, 6)],
    ]);
    expect(apply({ due: "next_week" })).toEqual([
      ["gte", "due_date", addDays(monday, 7)],
      ["lte", "due_date", addDays(monday, 13)],
    ]);
  });

  it("no due date is a null test", () => {
    expect(apply({ due: "none" })).toEqual([["is", "due_date", null]]);
  });
});

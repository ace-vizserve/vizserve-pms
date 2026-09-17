import { describe, expect, it } from "vitest";

import {
  checkDefinition,
  compareFieldValues,
  createListFieldSchema,
  fieldIdFromKey,
  fieldKey,
  matchesFieldFilter,
  parseFieldFilter,
  readFieldValue,
  taskFieldValueSchema,
  type FieldValue,
  type ListField,
  type ListFieldType,
} from "@/lib/schemas/list-fields";

/**
 * P7-73 — the rules the task list sorts and filters custom fields by.
 *
 * The sort order was Ace's own request: a dropdown sorts by the order its
 * options were set in, not alphabetically — "Low, Medium, High" must never come
 * out as "High, Low, Medium".
 */

const LIST = "00000000-0000-4000-8000-000000000001";

function field(type: ListFieldType, overrides: Partial<ListField> = {}): ListField {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    list_id: LIST,
    name: "Field",
    field_type: type,
    options: [],
    decimals: type === "NUMBER" ? 0 : null,
    sort_order: 0,
    is_active: true,
    ...overrides,
  };
}

const priority = field("DROPDOWN", {
  options: [
    { id: "low", label: "Low", color: "neutral", is_active: true },
    { id: "medium", label: "Medium", color: "warning", is_active: true },
    { id: "old", label: "Legacy", color: "neutral", is_active: false },
    { id: "high", label: "High", color: "danger", is_active: true },
  ],
});

const tags = field("LABELS", { options: priority.options });

function sorted(f: ListField, values: (FieldValue | null)[], dir: "asc" | "desc" = "asc") {
  return [...values].sort((a, b) => compareFieldValues(f, a, b, dir));
}

describe("sorting", () => {
  it("orders a dropdown by option order, not alphabetically", () => {
    expect(sorted(priority, ["high", "low", "medium"])).toEqual(["low", "medium", "high"]);
    expect(sorted(priority, ["high", "low", "medium"], "desc")).toEqual(["high", "medium", "low"]);
  });

  it("puts an archived option after every active one", () => {
    expect(sorted(priority, ["old", "high", "low"])).toEqual(["low", "high", "old"]);
  });

  it("keeps empty values last in both directions", () => {
    expect(sorted(priority, [null, "high", "low"])).toEqual(["low", "high", null]);
    expect(sorted(priority, [null, "high", "low"], "desc")).toEqual(["high", "low", null]);
    expect(sorted(field("NUMBER"), [null, 3, 1], "desc")).toEqual([3, 1, null]);
  });

  it("orders labels by the highest-ranked option, then the next, then fewer first", () => {
    expect(
      sorted(tags, [["high"], ["medium", "high"], ["low", "high"], ["low"]]),
    ).toEqual([["low"], ["low", "high"], ["medium", "high"], ["high"]]);
  });

  it("puts checked boxes first, and unset counts as unchecked", () => {
    const box = field("CHECKBOX");
    expect(sorted(box, [null, true, null])).toEqual([true, null, null]);
    expect(sorted(box, [true, null], "desc")).toEqual([null, true]);
  });

  it("sorts numbers numerically, not as text", () => {
    expect(sorted(field("NUMBER"), [10, 9, 100])).toEqual([9, 10, 100]);
  });

  it("sorts text case-insensitively and dates chronologically", () => {
    expect(sorted(field("TEXT"), ["banana", "Apple", "cherry"])).toEqual(["Apple", "banana", "cherry"]);
    expect(sorted(field("DATE"), ["2026-10-01", "2026-01-15"])).toEqual(["2026-01-15", "2026-10-01"]);
  });
});

describe("filtering", () => {
  it("matches a dropdown option and a label a task includes", () => {
    const f = parseFieldFilter(priority, "medium")!;
    expect(matchesFieldFilter(priority, f, "medium")).toBe(true);
    expect(matchesFieldFilter(priority, f, "high")).toBe(false);
    expect(matchesFieldFilter(tags, parseFieldFilter(tags, "high")!, ["low", "high"])).toBe(true);
  });

  it("ignores an option id the field does not have", () => {
    expect(parseFieldFilter(priority, "nope")).toBeNull();
  });

  it("filters a checkbox, where unset is unchecked", () => {
    const box = field("CHECKBOX");
    expect(matchesFieldFilter(box, parseFieldFilter(box, "no")!, null)).toBe(true);
    expect(matchesFieldFilter(box, parseFieldFilter(box, "yes")!, null)).toBe(false);
  });

  it("filters number and date ranges with either end open", () => {
    const n = field("NUMBER");
    expect(matchesFieldFilter(n, parseFieldFilter(n, "5..")!, 7)).toBe(true);
    expect(matchesFieldFilter(n, parseFieldFilter(n, "..5")!, 7)).toBe(false);
    expect(parseFieldFilter(n, "abc..")).toBeNull();

    const d = field("DATE");
    const range = parseFieldFilter(d, "2026-09-01..2026-09-30")!;
    expect(matchesFieldFilter(d, range, "2026-09-17")).toBe(true);
    expect(matchesFieldFilter(d, range, null)).toBe(false);
  });

  it("filters text by contains, case-insensitively", () => {
    const t = field("TEXT");
    expect(matchesFieldFilter(t, parseFieldFilter(t, "ACME")!, "Acme Corp")).toBe(true);
  });
});

describe("values", () => {
  it("refuses an archived option on write, but still reads one already held", () => {
    expect(taskFieldValueSchema(priority).safeParse("old").success).toBe(false);
    expect(readFieldValue(priority, { [priority.id]: "old" })).toBe("old");
  });

  it("refuses the same label twice", () => {
    expect(taskFieldValueSchema(tags).safeParse(["low", "low"]).success).toBe(false);
  });

  it("reads a value of the wrong shape as empty rather than throwing", () => {
    expect(readFieldValue(field("NUMBER"), { [priority.id]: "12" })).toBeNull();
    expect(readFieldValue(field("NUMBER"), null)).toBeNull();
  });
});

describe("definitions", () => {
  it("needs at least one option on a dropdown", () => {
    const result = createListFieldSchema.safeParse({ list_id: LIST, name: "Stage", field_type: "DROPDOWN" });
    expect(result.success).toBe(false);
  });

  it("refuses two active options with one label", () => {
    const options = [
      { id: "a", label: "Done", color: "success", is_active: true },
      { id: "b", label: "done", color: "neutral", is_active: true },
    ] as const;
    expect(checkDefinition("DROPDOWN", [...options], null)).not.toBeNull();
  });

  it("needs decimal places on a number and nowhere else", () => {
    expect(checkDefinition("NUMBER", [], null)).not.toBeNull();
    expect(checkDefinition("NUMBER", [], 2)).toBeNull();
    expect(checkDefinition("TEXT", [], 2)).not.toBeNull();
  });

  it("round-trips a column key", () => {
    expect(fieldIdFromKey(fieldKey(priority.id))).toBe(priority.id);
    expect(fieldIdFromKey("due")).toBeNull();
  });
});

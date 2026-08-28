import { describe, expect, it } from "vitest";

import {
  auditActionLabel,
  auditActionTone,
  auditEntityHref,
  auditEntityLabel,
  auditFields,
  formatAuditValue,
  isAuditEntityType,
  isAuditPeriod,
  isUuid,
} from "@/lib/audit";

/** Real ids from the dev database, so the lookup cases are the live shape. */
const VACATION = "8601250c-12a9-4c98-85d4-876c055a259a";
const SICK = "018228a7-14b3-44c5-8dc8-b93ac2ccea86";
const TL = "2105d7f9-366e-4d20-9e07-bdbe0d39b642";

const LOOKUP = {
  [VACATION]: "Vacation Leave",
  [SICK]: "Sick Leave",
  [TL]: "TL VizBytes",
};

const changedLabels = (fields: ReturnType<typeof auditFields>) =>
  fields.filter((field) => field.changed).map((field) => field.label);

/**
 * `lib/audit.ts` renders columns that are FREE TEXT in Postgres — `entity_type`
 * and `action` are both `text`, written from server actions and from a dozen
 * SQL functions, several of which pass `lower(v_status::text)`. So the contract
 * under test is mostly "an unknown string still renders", not "the known ones
 * look right".
 */

describe("action labels — the long tail must survive", () => {
  it("humanises a snake_case action nobody pinned", () => {
    expect(auditActionLabel("status_overridden")).toBe("Status overridden");
  });

  it("keeps pinned wording where the humanised form would be wrong", () => {
    // "Punch in" reads as an instruction; the trail records things that already
    // happened.
    expect(auditActionLabel("punch_in")).toBe("Timed in");
  });

  it("returns an unknown action unchanged rather than blank", () => {
    // A migration lands with a new action string long before this file learns
    // about it. An empty cell would read as a broken row.
    expect(auditActionLabel("quarantined")).toBe("Quarantined");
  });

  it("falls back to neutral for an action with no tone", () => {
    expect(auditActionTone("quarantined")).toBe("neutral");
    expect(auditActionTone("deleted")).toBe("danger");
  });
});

describe("entity labels and links", () => {
  it("names a known type", () => {
    expect(auditEntityLabel("internal_request")).toBe("Internal request");
  });

  it("shows the raw key for a type not in the map", () => {
    expect(auditEntityLabel("form_field")).toBe("form_field");
  });

  it("links only the types with a detail route", () => {
    expect(auditEntityHref("task", "abc")).toBe("/tasks/abc");
    // No per-row route for a user — the admin screen is a list, so a link would
    // drop the reader on a page and leave them to find the row.
    expect(auditEntityHref("user", "abc")).toBeNull();
  });

  it("narrows an untrusted filter value", () => {
    expect(isAuditEntityType("task")).toBe(true);
    expect(isAuditEntityType("tasks")).toBe(false);
    expect(isAuditPeriod("30")).toBe(true);
    expect(isAuditPeriod("31")).toBe(false);
  });
});

describe("auditFields — the union of both payloads, flattened", () => {
  it("finds the one field that moved out of several that did not", () => {
    const before = { role: "member", is_active: true, full_name: "Ada" };
    const after = { role: "team_leader", is_active: true, full_name: "Ada" };
    expect(changedLabels(auditFields(before, after))).toEqual(["Role"]);
  });

  it("treats a create (null before) as every field being recorded", () => {
    expect(changedLabels(auditFields(null, { role: "member", full_name: "Ada" }))).toEqual([
      "Full name",
      "Role",
    ]);
  });

  it("treats a delete (null after) the same way", () => {
    expect(changedLabels(auditFields({ title: "Draft brief" }, null))).toEqual(["Title"]);
  });

  it("includes a key present on only one side", () => {
    // A column added since the row was written exists on the after side alone.
    // Taking one side's keys would silently hide it.
    expect(changedLabels(auditFields({ a: 1 }, { a: 1, b: 2 }))).toEqual(["B"]);
  });

  it("does not report absent-versus-explicit-null as a change", () => {
    /**
     * The `— → —` row. `vizserve_pms_create_manual_task` writes
     * `"priority": null` against a `before` of null, and comparing `undefined`
     * to `null` by stringify made every create claim its priority had changed —
     * then rendered both sides as an em-dash, asserting that nothing became
     * nothing.
     */
    const fields = auditFields(null, { title: "P7-17 task", priority: null });
    expect(changedLabels(fields)).toEqual(["Title"]);
    expect(fields.find((field) => field.label === "Priority")?.changed).toBe(false);
  });

  it("returns nothing for two payloads that are both absent", () => {
    // A punch or a submit records that something happened and carries no
    // values. That is a supported entry, not a malformed one.
    expect(auditFields(null, null)).toEqual([]);
  });

  it("expands a nested map into one row per key instead of dumping JSON", () => {
    /**
     * The leave allocation entry. Nine leave types inside one `allocations`
     * object used to render as a single 500-character line in both columns,
     * identical apart from one digit.
     */
    const before = { balance_year: 2026, allocations: { [VACATION]: 10, [SICK]: 10 } };
    const after = { balance_year: 2026, allocations: { [VACATION]: 11, [SICK]: 10 } };

    const fields = auditFields(before, after, LOOKUP);

    // Three rows — the year and the two leave types — not one blob.
    expect(fields).toHaveLength(3);
    expect(changedLabels(fields)).toEqual(["Vacation Leave"]);

    const vacation = fields.find((field) => field.label === "Vacation Leave");
    expect(vacation).toMatchObject({ group: "Allocations", before: "10", after: "11" });
  });

  it("resolves an id-shaped VALUE to the thing it names", () => {
    const fields = auditFields(null, { assignee_id: TL }, LOOKUP);
    expect(fields[0]).toMatchObject({ label: "Assignee id", after: "TL VizBytes" });
  });

  it("shortens an id it cannot name rather than printing the whole thing", () => {
    // The lookup covers users, leave types and departments. Anything else has
    // to degrade to something that still fits a cell.
    const orphan = "ffffffff-1111-4222-8333-444444444444";
    expect(formatAuditValue(orphan, LOOKUP)).toBe("ffffffff…");
  });
});

describe("formatAuditValue — a jsonb leaf on one line", () => {
  it("shows an em-dash for absent, never the word null", () => {
    expect(formatAuditValue(null)).toBe("—");
    expect(formatAuditValue(undefined)).toBe("—");
    expect(formatAuditValue("")).toBe("—");
  });

  it("words a boolean", () => {
    expect(formatAuditValue(true)).toBe("Yes");
    expect(formatAuditValue(false)).toBe("No");
  });

  it("keeps a zero, which is a value and not an absence", () => {
    expect(formatAuditValue(0)).toBe("0");
  });

  it("joins an array of scalars rather than showing its punctuation", () => {
    expect(formatAuditValue(["pms", "sis"])).toBe("pms, sis");
  });

  it("keeps JSON for an array of objects, which nothing writes yet", () => {
    // Ugly and honest. Inventing a rendering for a shape no call site produces
    // would be a guess that silently drops fields the day one does.
    expect(formatAuditValue([{ a: 1 }])).toBe('[{"a":1}]');
  });
});

describe("isUuid — routes the search box to the right column", () => {
  /**
   * Load-bearing. `entity_id` is a `uuid` column and Postgres has no
   * `uuid ~~ text` operator, so an ilike against it is a 400 the reader sees as
   * "search is broken".
   */
  it("matches a pasted id in either case", () => {
    expect(isUuid("0e2c9a3e-1f4b-4c8a-9d21-5b6e7f8a9c01")).toBe(true);
    expect(isUuid("0E2C9A3E-1F4B-4C8A-9D21-5B6E7F8A9C01")).toBe(true);
  });

  it("rejects an ordinary search term", () => {
    expect(isUuid("deleted")).toBe(false);
    expect(isUuid("0e2c9a3e-1f4b-4c8a-9d21")).toBe(false);
    // Trailing junk must not slip through — an anchored pattern, not a search.
    expect(isUuid("0e2c9a3e-1f4b-4c8a-9d21-5b6e7f8a9c01x")).toBe(false);
  });
});

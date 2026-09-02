import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P7-66 — the one thing that can silently rot in the `/tasks` columns menu.
 *
 * The menu's list is static: `/tasks` builds its real columns per status group
 * from lookups the page header does not hold, so the dropdown is populated from
 * a hand-written array instead of from the columns themselves.
 *
 * That buys one round trip and costs one risk — a key renamed in the columns
 * and not in the menu leaves a checkbox that toggles a column nobody has, with
 * no error anywhere. This asserts the two lists agree.
 *
 * Read as SOURCE rather than imported: the module is a client component pulling
 * in TanStack, lucide and half the task row's controls, and none of that is
 * needed to compare two lists of strings.
 */

const source = readFileSync(
  join(process.cwd(), "app/(app)/tasks/tasks-table.tsx"),
  "utf8",
);

/** The keys the menu offers. */
function menuKeys(): string[] {
  const block = source.slice(
    source.indexOf("const TASK_MENU_COLUMNS"),
    source.indexOf("type TaskColumnState"),
  );

  return [...block.matchAll(/key: "([a-z]+)"/g)].map((match) => match[1]);
}

/** The keys the real columns mark `hideable`, in declaration order. */
function hideableColumnKeys(): string[] {
  const block = source.slice(source.indexOf("const columns: Column<ListRow>[] = ["));
  const keys: string[] = [];

  // Each column is `key: "..."` optionally followed by flags; a column counts
  // when `hideable: true` appears before the next `key:`.
  const entries = block.split(/\n      key: "/).slice(1);
  for (const entry of entries) {
    const key = entry.slice(0, entry.indexOf('"'));
    const untilNextKey = entry.split("\n    {")[0];
    if (untilNextKey.includes("hideable: true")) keys.push(key);
  }

  return keys;
}

describe("the /tasks columns menu", () => {
  it("offers exactly the columns the table marks hideable", () => {
    expect(menuKeys().slice().sort()).toEqual(hideableColumnKeys().slice().sort());
  });

  it("offers something at all", () => {
    // Guards the parsing above as much as the data: a regex that silently stops
    // matching would make the assertion above pass on two empty lists.
    expect(menuKeys().length).toBeGreaterThan(0);
  });

  it("never offers a structural column", () => {
    // Hiding any of these leaves a table that cannot be read or acted on, so
    // they must never gain `hideable` — the selection box, the title, and the
    // priority a row is triaged by.
    for (const structural of ["select", "task", "priority", "due"]) {
      expect(menuKeys()).not.toContain(structural);
    }
  });
});

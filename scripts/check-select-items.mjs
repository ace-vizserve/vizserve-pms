#!/usr/bin/env node
/**
 * Fails the build if a `<Select>` renders a `<SelectValue>` without an `items` map.
 *
 * Why this exists: Base UI's `Select.Value` prints the ROOT'S RAW VALUE. It does
 * not read the label off the matching `<SelectItem>` — it cannot, because the
 * list is only mounted while the popup is open. Handing the root an
 * `items` map (value → label) is the only thing that makes the closed trigger
 * show words.
 *
 * Without it the same control says two different things depending on whether
 * you are looking at it:
 *
 *   closed:  8601250c-12a9-4c98-85d4-876c0…      open:  Vacation Leave
 *   closed:  __ALL__                             open:  All departments
 *   closed:  LABEL_HIDDEN                        open:  Label hidden
 *
 * The last one is a database enum on a screen, which the design system rules
 * out outright ("Never expose an enum value, a table name, or a UUID to a
 * user"). The first is worse: a UUID is not merely unfriendly, it tells the
 * reader nothing at all about what is selected.
 *
 * ⚠️ THIS WAS ALREADY WRITTEN DOWN — in a comment in app/(app)/requests/filters.tsx
 * — and it kept happening anyway, four times, across three years of screens. A
 * comment explains the trap to somebody already reading the right file. This
 * fails the build.
 *
 * The rule is absolute on purpose. Two of the call sites it flags are harmless
 * today because their value and their label are the same string (a page size of
 * "20", a public form's free-text options) — but "harmless because the two
 * happen to match" is a property that quietly stops holding, and an exemption
 * list is a place for the next real bug to hide.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components"];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }

  return out;
}

/**
 * The end of an opening tag, skipping over `{...}` so a `>` inside an arrow
 * function (`onValueChange={(v) => set(v)}`) does not look like the end of it.
 */
function endOfOpeningTag(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return i;
  }
  return source.length;
}

const offenders = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("<SelectValue")) continue;

    // `<Select` exactly — never `<SelectTrigger`, `<SelectItem`, and so on.
    const roots = source.matchAll(/<Select(?![A-Za-z])/g);

    for (const root of roots) {
      const openingEnd = endOfOpeningTag(source, root.index);
      const opening = source.slice(root.index, openingEnd + 1);

      // A root in a doc comment or a string is not a root.
      const lineStart = source.lastIndexOf("\n", root.index) + 1;
      const linePrefix = source.slice(lineStart, root.index).trimStart();
      if (linePrefix.startsWith("*") || linePrefix.startsWith("//")) continue;

      const close = source.indexOf("</Select>", openingEnd);
      const body = source.slice(openingEnd, close === -1 ? source.length : close);

      // Only roots that actually display a value are affected.
      if (!body.includes("<SelectValue")) continue;
      if (/\bitems=/.test(opening)) continue;

      offenders.push({
        file: relative(ROOT, file).split("\\").join("/"),
        line: source.slice(0, root.index).split("\n").length,
      });
    }
  }
}

if (offenders.length > 0) {
  console.error("\n<Select> without an `items` map — the trigger will show the raw value:\n");
  for (const offender of offenders) console.error(`  ${offender.file}:${offender.line}`);
  console.error(
    "\nHand the ROOT a value -> label map, the way app/(app)/requests/filters.tsx does:\n" +
      "\n  const statusItems: Record<string, string> = {\n" +
      "    [ALL]: 'All statuses',\n" +
      "    ...Object.fromEntries(options.map((o) => [o.value, o.label])),\n" +
      "  };\n" +
      "  <Select items={statusItems} …>\n" +
      "\nEvery value the list can hold needs an entry, the sentinel included —\n" +
      "a map built by spreading the rows alone leaves the trigger reading '__ALL__'.\n",
  );
  process.exit(1);
}

console.log(`check:select-items — no <Select> is missing its items map.`);

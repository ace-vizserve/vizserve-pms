import { describe, expect, it } from "vitest";

import { CHANGELOG, changelogFilenames } from "@/lib/changelog";
import { isDateOnly, parseDateOnly } from "@/lib/dates";

/**
 * The changelog is hand-maintained, and "add to the TOP" is exactly the kind of
 * instruction that gets missed at the end of a long day. These are the ways the
 * list can be wrong without anybody noticing, because the page renders a
 * mis-ordered or mis-dated entry perfectly happily.
 *
 * ⚠️ THE ENTRIES ARE JSON NOW, so `tsc` no longer checks them at all. Loading
 * `lib/changelog.ts` parses every file through `lib/schemas/changelog.ts` and
 * throws on the first bad one, which means the import at the top of this file
 * is itself the schema assertion — a misspelt `area` fails here before any
 * `it()` runs.
 */
describe("changelog", () => {
  it("is not empty", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });

  it("carries a real calendar date on every entry", () => {
    for (const entry of CHANGELOG) {
      // Shape first, then validity: `isDateOnly` accepts "2026-02-31" and
      // `parseDateOnly` is what rejects it, so both are needed. The schema's
      // regex is the same shape check, and stops at the same place.
      expect(isDateOnly(entry.date), `${entry.title}: ${entry.date}`).toBe(true);
      expect(parseDateOnly(entry.date), `${entry.title}: ${entry.date}`).not.toBeNull();
    }
  });

  it("reads newest first", () => {
    const dates = CHANGELOG.map((entry) => entry.date);
    // A plain string comparison is correct for zero-padded YYYY-MM-DD, and it
    // avoids re-parsing 20-odd dates to answer a question about ordering.
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("has no duplicate entries", () => {
    const keys = CHANGELOG.map((entry) => `${entry.date}::${entry.title}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says something in every entry", () => {
    for (const entry of CHANGELOG) {
      expect(entry.title.trim().length, entry.date).toBeGreaterThan(0);
      expect(entry.description.trim().length, entry.title).toBeGreaterThan(0);
      // An empty array renders as an empty <ul>, which is a bullet list with no
      // bullets rather than no list at all.
      if (entry.items) expect(entry.items.length, entry.title).toBeGreaterThan(0);
      if (entry.refs) expect(entry.refs.length, entry.title).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠️ THE DATE IS IN THE FILENAME AND IN THE PAYLOAD, AND ONLY ONE OF THEM IS
   * AUTHORITATIVE. The loader reads the field; the filename is a sortable
   * label for humans browsing the directory. They drift the first time
   * somebody copies a file to start a new entry and forgets one of the two —
   * at which point the directory listing and the page disagree about when
   * something shipped, and neither looks wrong on its own.
   */
  it("names every file after the date inside it", () => {
    const files = changelogFilenames();
    expect(files.length).toBe(CHANGELOG.length);

    for (const name of files) {
      const prefix = name.slice(0, 10);
      expect(isDateOnly(prefix), `${name}: filename must start with YYYY-MM-DD`).toBe(true);

      const matching = CHANGELOG.filter((entry) => entry.date === prefix);
      expect(matching.length, `${name}: no entry is dated ${prefix}`).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from "vitest";

import { resolveVisibility } from "@/components/data-table-columns";

/**
 * P7-66 — the columns menu's one real rule.
 *
 * Most of that component is markup. This is the part with a decision in it: a
 * column can be hidden because nobody has said otherwise, or hidden because
 * somebody said so, and the two must not be confused. Getting it wrong looks
 * exactly like the preference failing to save, which is the kind of bug people
 * stop reporting and start working around.
 */

describe("resolveVisibility", () => {
  it("hides a default-hidden column when nothing is stored", () => {
    expect(resolveVisibility(null, ["department"])).toEqual({ department: false });
  });

  it("shows everything when there are no defaults and nothing stored", () => {
    expect(resolveVisibility(null, [])).toEqual({});
  });

  it("⚠️ keeps a column somebody switched ON, against the default", () => {
    // The regression this exists to prevent: seeding on top of the stored value
    // would turn `department` back off on the next visit, and the person would
    // reasonably conclude the setting does not save.
    const stored = JSON.stringify({ department: true });

    expect(resolveVisibility(stored, ["department"])).toEqual({ department: true });
  });

  it("keeps a column somebody switched OFF that has no default", () => {
    const stored = JSON.stringify({ email: false });

    expect(resolveVisibility(stored, ["department"])).toEqual({
      department: false,
      email: false,
    });
  });

  it("leaves columns nobody has an opinion about unmentioned", () => {
    // Absent from the result means "visible" to TanStack, which is the point:
    // only a column with a reason to be hidden appears here at all.
    const out = resolveVisibility(JSON.stringify({ a: false }), ["b"]);

    expect(out).toEqual({ a: false, b: false });
    expect("c" in out).toBe(false);
  });

  it("falls back to the defaults when storage holds something unreadable", () => {
    // A half-written value, or a key another version of this app wrote. Trusting
    // it would be worse than ignoring it.
    for (const junk of ["", "not json", "[]", "null", "42", '"a string"']) {
      expect(resolveVisibility(junk, ["department"])).toEqual({ department: false });
    }
  });
});

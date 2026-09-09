import { describe, expect, it } from "vitest";

import { richTextLength } from "@/lib/rich-text";
import { INTERNAL_REASON_MAX, withdrawNoteSchema } from "@/lib/schemas/internal-requests";

/**
 * P11-13 — the note on a withdrawal is OPTIONAL, and this file is the guard on
 * that word.
 *
 * Every other free-text field in `internal-requests.ts` carries a five-character
 * floor, and the obvious way to add this one is to copy the field next to it.
 * That would quietly reverse P9-03's central asymmetry: a lead who wants a
 * request gone has `reject`, which demands a reason, and the author has
 * `withdraw`, which demands nothing — precisely because withdrawing is the one
 * act here a person performs on their own work. A floor on this box turns
 * "would you like to say why?" into "you may not take this back without
 * explaining yourself", and nothing on the screen would say so.
 *
 * The cap is real and is measured on prose rather than markup, for the reason
 * `decision-reason.test.ts` sets out at length.
 */
describe("withdrawNoteSchema", () => {
  it("accepts nothing at all — the ordinary case", () => {
    // What the dialog sends when somebody opens it and types nothing. The
    // editor is always rendered, so "" is what actually arrives, not undefined.
    expect(withdrawNoteSchema.safeParse({ note: "" })).toMatchObject({ success: true });

    // And what a caller written before P11-13 sends: nothing at all.
    const bare = withdrawNoteSchema.safeParse({});
    expect(bare.success).toBe(true);
    expect(bare.success && bare.data.note).toBe("");
  });

  it("treats an empty document as nothing, not as content", () => {
    // What TipTap leaves behind when somebody clicks into the box, presses
    // return and thinks better of it: fourteen characters of markup and no
    // prose. Without the transform in `richTextSchema` this reaches the column
    // as a note, and the request page renders an empty paragraph where "with no
    // note" belongs — the `|| null` in the action cannot tell the difference.
    const empty = "<p></p><p></p>";
    expect(empty.length).toBeGreaterThan(0);
    expect(richTextLength(empty)).toBe(0);

    const result = withdrawNoteSchema.safeParse({ note: empty });
    expect(result.success).toBe(true);
    expect(result.success && result.data.note).toBe("");
  });

  it("keeps a bullet, because a bullet is something somebody typed", () => {
    /*
     * ⚠️ NOT the same case as above, and the difference is deliberate in
     * `richTextToPlainText`: `<li>` flattens to a "• " marker so a three-point
     * note does not reach an inbox as one run-on sentence. An empty list item
     * therefore measures 1, not 0.
     *
     * Stated here because the obvious reading — "no text between the tags, so
     * it is empty" — is wrong, and a future tidy-up of the flattener that drops
     * the marker would silently change what this field stores.
     */
    expect(richTextLength("<ul><li></li></ul>")).toBe(1);

    const result = withdrawNoteSchema.safeParse({ note: "<ul><li></li></ul>" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.note).toBe("<ul><li></li></ul>");
  });

  it("accepts a short one — there is no floor to clear", () => {
    // Four characters of prose. `internalReasonSchema` would refuse this, and
    // that difference is the whole point of the field.
    const result = withdrawNoteSchema.safeParse({ note: "<p>Oops</p>" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.note).toBe("<p>Oops</p>");
  });

  it("caps on prose rather than markup", () => {
    // Under the cap in prose, far over it in characters. A plain `.max()` on
    // the string would refuse a note somebody is entitled to write.
    const heavilyFormatted = "<p><strong><em>Filed the wrong dates.</em></strong></p>".repeat(60);
    expect(heavilyFormatted.length).toBeGreaterThan(INTERNAL_REASON_MAX);
    expect(richTextLength(heavilyFormatted)).toBeLessThan(INTERNAL_REASON_MAX);
    expect(withdrawNoteSchema.safeParse({ note: heavilyFormatted }).success).toBe(true);

    // And genuinely too long is still refused.
    const tooLong = `<p>${"x".repeat(INTERNAL_REASON_MAX + 1)}</p>`;
    expect(withdrawNoteSchema.safeParse({ note: tooLong }).success).toBe(false);
  });
});

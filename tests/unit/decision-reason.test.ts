import { describe, expect, it } from "vitest";

import { richTextLength } from "@/lib/rich-text";
import { decisionReasonSchema } from "@/lib/schemas/approvals";

/**
 * P11-02 — the Gate 1 rejection reason is measured on PROSE, not on markup.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE THE FIELD SHIPPED WRONG AND NOTHING CAUGHT IT.
 * `decisionReasonSchema` was a plain `z.string().trim().min(10).max(2000)` while
 * the control feeding it is a `RichTextEditor`. So it counted tags:
 *
 *   "<p><strong>no</strong></p>"   26 characters of markup, 2 of prose
 *
 * That cleared the floor, and the submit button agreed with it because it gated
 * on `reason.trim().length` too. A client with no other channel received a
 * rejection whose entire explanation was "no". Bolding a two-letter refusal is
 * not a contrived case — it is what somebody does when they are annoyed.
 *
 * The header of `lib/schemas/rich-text.ts` warns about exactly this and names
 * both halves of it — a floor that accepts an empty document, and a cap that
 * cuts to a few hundred real characters. This field was the one that did not
 * follow it.
 */
describe("decisionReasonSchema", () => {
  it("counts prose, not tags — the case that used to pass", () => {
    const markup = "<p><strong>no</strong></p>";

    // The premise, stated so a future reader can see how 10 was ever cleared:
    // the OLD rule would have accepted this, the new one must not.
    expect(markup.trim().length).toBeGreaterThanOrEqual(10);
    expect(richTextLength(markup)).toBe(2);

    expect(decisionReasonSchema.safeParse(markup).success).toBe(false);
  });

  it("still refuses a longer document that says nothing", () => {
    // 40 characters of markup, none of them prose.
    const empty = "<p></p><p></p><ul><li></li></ul><p></p>";
    expect(empty.length).toBeGreaterThan(10);
    expect(decisionReasonSchema.safeParse(empty).success).toBe(false);
  });

  it("accepts a real sentence, formatted", () => {
    const result = decisionReasonSchema.safeParse(
      "<p>The brief lists <strong>three</strong> sizes but only names two.</p>",
    );
    expect(result.success).toBe(true);
  });

  it("accepts plain text too — the schema does not require markup", () => {
    expect(decisionReasonSchema.safeParse("Needs a third size before we can start.").success).toBe(
      true,
    );
  });

  it("says something a person can act on when it refuses", () => {
    const result = decisionReasonSchema.safeParse("<p><em>no</em></p>");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("at least a sentence");
    }
  });

  /**
   * The other half of the same defect. A plain `.max(2000)` on markup spends the
   * budget on tags, so a reason well inside the limit is refused for being too
   * long — the failure nobody reports because it looks like a rule.
   */
  it("spends the 2000 cap on prose, not on markup", () => {
    const prose = "a".repeat(1_990);
    const wrapped = `<p><strong>${prose}</strong></p>`;

    expect(wrapped.length).toBeGreaterThan(2_000);
    expect(richTextLength(wrapped)).toBe(1_990);
    expect(decisionReasonSchema.safeParse(wrapped).success).toBe(true);
  });

  it("still refuses prose that is genuinely over the cap", () => {
    expect(decisionReasonSchema.safeParse("<p>" + "a".repeat(2_001) + "</p>").success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { normaliseOptionsText } from "@/lib/form-builder/attributes";
import { emptyFormSchema } from "@/lib/form-builder/builder";
import { planSchemaSave } from "@/lib/form-builder/save-outcome";

/**
 * P7-66 — the two rules the form builder's own editing behaviour rests on.
 *
 * Neither is reachable from a unit test through the components that use them —
 * the options editor is a `@coltorapps/builder-react` attribute component and
 * the save path is a `useTransition` inside a client component — so the rules
 * were extracted to be run directly. That is the point of both modules: the
 * decision is somewhere it can be stated once and checked, rather than inline in
 * a handler where it was got wrong.
 */

describe("normaliseOptionsText", () => {
  it("takes one option per line, trimmed, blanks dropped", () => {
    expect(normaliseOptionsText("Poster\n Banner \n\nSocial media set\n")).toEqual([
      "Poster",
      "Banner",
      "Social media set",
    ]);
  });

  it("keeps the spaces inside an option", () => {
    // The option is a stored VALUE — `selectEntity` builds `z.enum(options)`
    // from this list — so only the ends are tidied. "Social media set" is one
    // choice, not three.
    expect(normaliseOptionsText("Social media set")).toEqual(["Social media set"]);
  });

  it("reads a list pasted from Windows or a spreadsheet", () => {
    expect(normaliseOptionsText("Poster\r\nBanner")).toEqual(["Poster", "Banner"]);
  });

  it("cannot be applied to the text somebody is still typing", () => {
    /*
     * ⚠️ THIS IS THE BUG, STATED AS A RULE. The options editor drove its
     * textarea off `attribute.value.join("\n")` and normalised every keystroke
     * into the store, so what the textarea showed was the round trip below.
     *
     * Pressing Enter after `Poster` therefore re-rendered as `Poster` with the
     * newline gone — A SECOND OPTION COULD NEVER BE ENTERED — and the space in
     * `Social media` was eaten the instant it was pressed, so a multi-word
     * option was impossible too. The editor was unusable on arrival, and it is
     * the only way to configure a `select` or a `multiselect`.
     *
     * The rule is correct; applying it to a half-typed line is not. So the
     * editor keeps the raw text as its own state and calls this to decide what
     * is STORED, exactly as the hand-rolled builder it replaced did (raw string
     * in `useState`, split and trimmed in `submit`).
     */
    expect(normaliseOptionsText("Poster\n").join("\n")).not.toBe("Poster\n");
    expect(normaliseOptionsText("Social ").join("\n")).not.toBe("Social ");
  });
});

describe("planSchemaSave", () => {
  const schema = emptyFormSchema();

  it("hands back the document the database accepted", () => {
    expect(planSchemaSave({ outcome: "saved", schema }, true)).toEqual({ kind: "saved", schema });
  });

  it("reverts a refused mechanical change", () => {
    expect(planSchemaSave({ outcome: "refused", message: "Postgres said no." }, true)).toEqual({
      kind: "failed",
      message: "Postgres said no.",
      revert: true,
    });
  });

  it("reverts one the builder itself refused, exactly the same way", () => {
    /*
     * ⚠️ THE REGRESSION. `persist` returned early on the validation failure
     * without putting the store back, so an archive, a restore or a reorder that
     * was refused STAYED APPLIED on screen and rode along, unannounced, on the
     * next successful save of an unrelated field. The error said the save
     * failed; the list said it worked.
     *
     * Which half refused it makes no difference: either way the document on
     * screen is one the database does not hold.
     */
    expect(planSchemaSave({ outcome: "invalid", message: "Give the field a label." }, true)).toEqual(
      { kind: "failed", message: "Give the field a label.", revert: true },
    );
  });

  it("keeps what somebody typed when the caller asked it to", () => {
    // A field editor passes `revertOnFailure: false` because there IS something
    // typed behind it, and throwing that away because Postgres refused a rename
    // would delete the work the person now has to correct.
    expect(planSchemaSave({ outcome: "invalid", message: "Give the field a label." }, false)).toEqual(
      { kind: "failed", message: "Give the field a label.", revert: false },
    );
  });
});

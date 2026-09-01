import type { FormSchema } from "@/lib/form-builder/builder";

/**
 * P7-66 — WHAT A SAVE ATTEMPT DOES TO THE BUILDER'S OWN STATE.
 *
 * A save can fail twice over: the builder's `validateSchema` can refuse the
 * document before it leaves the browser (a bad `key`, a duplicate one, an
 * option-less choice field), or Postgres can refuse it after
 * `vizserve_pms_save_form_schema` has seen it (the R5 guard on a renamed key or
 * a dropped field that holds answers).
 *
 * ⚠️ THE BUILDER USED TO TREAT THOSE TWO DIFFERENTLY, AND THAT WAS THE BUG.
 * `persist` returned early on the validation failure without putting the store
 * back, so a MECHANICAL change — archive, restore, reorder, the three callers
 * that pass `revertOnFailure` precisely because there is nothing typed behind
 * them — stayed applied in the UI after being refused. The list then showed an
 * order or an archived flag the database does not hold, and the change rode
 * along, unannounced, on the next successful save of some unrelated field. The
 * error message said the save failed while the screen said it worked.
 *
 * Which failure it was makes no difference to that: in both cases the document
 * on screen is one the database does not have. So the decision is made once,
 * here, over both outcomes, where it can be tested without a browser.
 *
 * `revertOnFailure` is still the caller's to choose. A field editor passes
 * `false` because it DOES have something typed behind it, and throwing that away
 * because Postgres refused a rename would delete the very work the person now
 * has to correct.
 */
export type SchemaSaveAttempt =
  | { outcome: "saved"; schema: FormSchema }
  /** The builder itself refused it; the schema never left the browser. */
  | { outcome: "invalid"; message: string }
  /** The database refused it. */
  | { outcome: "refused"; message: string };

export type SchemaSaveEffect =
  | { kind: "saved"; schema: FormSchema }
  | { kind: "failed"; message: string; revert: boolean };

export function planSchemaSave(
  attempt: SchemaSaveAttempt,
  revertOnFailure: boolean,
): SchemaSaveEffect {
  if (attempt.outcome === "saved") return { kind: "saved", schema: attempt.schema };

  return { kind: "failed", message: attempt.message, revert: revertOnFailure };
}

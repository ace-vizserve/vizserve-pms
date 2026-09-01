import { schemaFromPublicFields, type ParsedFormSchema } from "@/lib/form-builder/schema";
import { publicFormSchema } from "@/lib/schemas/forms";

/**
 * P7-66 — WHAT `vizserve_pms_get_public_form` ACTUALLY SAID, in three answers
 * rather than one.
 *
 * ⚠️ "THIS FORM IS CLOSED" AND "WE COULD NOT TELL" ARE DIFFERENT SENTENCES TO A
 * CLIENT, and collapsing them is a regression that reaches real traffic.
 *
 * The submit action read this RPC into a single `ParsedFormSchema | null`, so a
 * form that is genuinely absent or unpublished, a PostgREST or connection fault,
 * and a payload that did not parse all became `form_not_found` — and therefore
 * "This form is no longer accepting submissions." on a page with no session and
 * no other route in. A five-second network blip told a paying client to stop
 * trying, on one of four live published forms, with a request they had already
 * typed out sitting in front of them. Before the schema was loaded here at all,
 * that same blip produced "Something went wrong. Please try again." — the honest
 * answer, and the one somebody acts on correctly.
 *
 * So the three are told apart:
 *
 *   `closed`       the function returned no row. Its `where` is
 *                  `slug and is_public and is_active`, character for character
 *                  the lookup `vizserve_pms_submit_request` performs, so this is
 *                  the same condition the database would refuse on. Final.
 *   `unavailable`  we could not read it. RETRYABLE, and the caller must say so.
 *   `ok`           the schema, mint-checked.
 *
 * A payload that does not parse is `unavailable` rather than `closed` for the
 * same reason: retrying will not help, but the form is not closed, and telling a
 * client it is retires a form nobody has retired. It is our bug, and `reason`
 * carries it into the log rather than to the requester — the caller is
 * unauthenticated and the detail is ours.
 */
export type PublicFormLookup =
  | { status: "ok"; schema: ParsedFormSchema }
  | { status: "closed" }
  | { status: "unavailable"; reason: string };

/**
 * The RPC's `{ data, error }`, classified. Pure, so the branch that decides what
 * a client is told can be tested without a database.
 */
export function readPublicFormResponse(response: {
  data: unknown;
  error: { message: string } | null;
}): PublicFormLookup {
  if (response.error) {
    return { status: "unavailable", reason: response.error.message };
  }

  // `null` is how a SECURITY DEFINER function returning jsonb says "no such
  // row" — the one answer that genuinely means the form is not taking
  // submissions.
  if (response.data === null || response.data === undefined) {
    return { status: "closed" };
  }

  const parsed = publicFormSchema.safeParse(response.data);

  if (!parsed.success) {
    return { status: "unavailable", reason: "the form did not parse" };
  }

  return { status: "ok", schema: schemaFromPublicFields(parsed.data.fields) };
}

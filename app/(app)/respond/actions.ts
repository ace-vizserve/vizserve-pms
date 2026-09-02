"use server";

import { revalidatePath } from "next/cache";

import { requireAuthContext } from "@/lib/auth/authorization";
import type { Json } from "@/lib/database.types";
import { FormSchemaError, parseFormSchema } from "@/lib/form-builder/schema";
import { validateFieldValues } from "@/lib/form-builder/values";
import {
  formResponseSubmissionSchema,
  type FormResponseResult,
} from "@/lib/schemas/forms";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-66 Phase 4b — A COLLEAGUE ANSWERS AN ENGAGEMENT FORM.
 *
 * The whole path, and it is deliberately much shorter than the client one:
 *
 *   requireAuthContext()  →  re-read the form from its SLUG
 *                         →  validate with the SAME entity declarations the
 *                            browser rendered from
 *                         →  a plain INSERT through the ordinary RLS client.
 *
 * ⚠️ NO `SECURITY DEFINER` FUNCTION, AND THAT IS THE DESIGN RATHER THAN A
 * SHORTCUT. `vizserve_pms_submit_request` exists because the public form has no
 * session at all: `anon` holds no table privileges whatsoever (CLAUDE.md), so
 * the only way an unauthenticated stranger can write a row is through a
 * function that runs as somebody else. A colleague filling this form IS signed
 * in and DOES hold `insert` on the table, so the policy
 * `form responses insertable by their author` can do the enforcement directly —
 * `submitted_by = auth.uid()`, on a form Postgres re-checks is EMPLOYEE_
 * ENGAGEMENT and active. A definer function here would only move that check
 * somewhere it is harder to read while widening what the caller can reach.
 *
 * ⚠️ VALIDATION IS SERVER-SIDE AND IS NOT A SECOND COPY. It is
 * `validateFieldValues`, which runs the same `lib/form-builder/entities.ts`
 * declarations the browser ran, translating `field_key` → entity id and back
 * (§1). The browser's pass is a courtesy; this one is the rule, and the front
 * end will be bypassed.
 *
 * ⚠️ WHAT IS *NOT* ENFORCED IN POSTGRES, stated plainly because CLAUDE.md's
 * "rules live in the database" is a non-negotiable and this is a departure from
 * it. `field_values` has a `jsonb_typeof(...) = 'object'` CHECK and nothing
 * more: required-field and per-field validation happen here, in TypeScript.
 * That is the same trade P7-66 made for the public form (plan risk 3), taken
 * knowingly — and it is a smaller one here, because the caller is a named,
 * signed-in colleague rather than the open internet, and because a bad answer
 * to a pulse survey is a bad answer, not a request that skips a Gate.
 */

/**
 * ⚠️ MAY THE SAME PERSON ANSWER THE SAME FORM TWICE? YES — DECIDED, NOT
 * OVERLOOKED. There is no unique index on `(form_id, submitted_by)`.
 *
 * Three reasons, in the order they mattered:
 *
 *   1. NOT EVERY ENGAGEMENT FORM IS A SURVEY. A kudos nomination form is
 *      answered once per colleague you want to thank; a sign-up sheet is
 *      answered once per session. "One per person" would break both outright,
 *      and they are two of the three uses the original ask named.
 *   2. A FORM IS REUSED. A quarterly pulse survey is one row with one slug that
 *      people are pointed at again every quarter. A unique constraint would
 *      make the second quarter unanswerable and the fix would be to build a new
 *      form each time — which throws away the comparison the survey exists for.
 *   3. THERE IS NO EDIT AND NO DELETE. The table is append-only on purpose (a
 *      submitted response is a record). Somebody who answered wrongly has
 *      exactly one remedy, and it is to answer again. Forbidding that would
 *      leave a known-wrong row as the only row.
 *
 * The cost is real and is carried by the READING screen rather than by this
 * one: the Responses table shows every row with its submitter and its
 * timestamp, newest first, so a duplicate is visible and the latest answer is
 * the one at the top. If a particular form ever genuinely needs one answer per
 * person, that is a per-form setting with its own UI and its own partial unique
 * index — not a rule imposed on every form here by default.
 */
export async function submitFormResponse(input: unknown): Promise<FormResponseResult> {
  // FIRST. Everything below reads `context.userId`, and an unauthenticated
  // caller must not get as far as learning whether a slug exists.
  const context = await requireAuthContext();

  const parsed = formResponseSubmissionSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: "That submission could not be read. Reload the page and retry." };
  }

  const supabase = await createClient();

  /*
   * ⚠️ THE FORM IS RE-READ FROM THE SLUG AND RE-CHECKED, never taken on trust
   * from the payload.
   *
   * The two `.eq()`s are NOT a restatement of an RLS department filter (the
   * thing CLAUDE.md forbids) — they identify WHICH FORMS THIS ENDPOINT SERVES.
   * A team leader can legitimately read their own department's CLIENT_REQUEST
   * forms, so without them a lead could post an "answer" against a client form
   * and it would land in the wrong table with no reference number, no Gate 1
   * and no client email. Postgres refuses that row anyway — the INSERT policy
   * re-checks both — so this is the readable refusal in front of the
   * enforcement, exactly the arrangement the public form has.
   */
  const { data: form, error: formError } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, schema")
    .eq("slug", parsed.data.slug)
    .eq("purpose", "EMPLOYEE_ENGAGEMENT")
    .eq("is_active", true)
    .maybeSingle();

  // Told apart, for the reason lib/form-builder/public-lookup.ts sets out at
  // length: "this form is closed" and "we could not read it" are different
  // sentences, and only one of them means stop trying.
  if (formError) {
    return { ok: false, error: `This form could not be read. ${formError.message}` };
  }

  if (!form) {
    return { ok: false, error: "This form is no longer accepting answers." };
  }

  let schema;

  try {
    schema = await parseFormSchema(form.schema);
  } catch (cause) {
    if (!(cause instanceof FormSchemaError)) throw cause;

    // The reason CODE, not the payload — it can carry a raw thrown value.
    console.error("[P7-66] refused a form schema on /respond", {
      slug: parsed.data.slug,
      reason: cause.reason.code,
    });
    return { ok: false, error: "This form could not be opened. Tell whoever set it up." };
  }

  const validation = await validateFieldValues(schema, parsed.data.field_values);

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.formError ?? "Please correct the highlighted answers.",
      field_errors: validation.fieldErrors,
    };
  }

  /*
   * ⚠️ NO `.select()` ON THE INSERT. The SELECT policy is admin-or-lead of the
   * owning department and the author is neither, so PostgREST would filter the
   * returned row and hand back "no rows" — a write that succeeded, reported as
   * a failure. Nothing here needs the id: the page confirms from this result.
   *
   * `submitted_by` is written from the SESSION, never from the payload, and
   * `submitted_by = auth.uid()` in the policy is what makes that unbypassable.
   *
   * `validation.values`, not `parsed.data.field_values` — the validated output
   * is what goes in. It has been through the entity validators, so an untouched
   * optional field is absent rather than stored as `""` pretending to be an
   * answer, and a key belonging to no field on this form has been dropped.
   */
  const { error: insertError } = await supabase.from("vizserve_pms_form_responses").insert({
    form_id: form.id,
    submitted_by: context.userId,
    field_values: validation.values as Json,
  });

  if (insertError) {
    console.error("[P7-66] a form response was refused", {
      formId: form.id,
      code: insertError.code,
    });
    return { ok: false, error: `Your answer could not be saved. ${insertError.message}` };
  }

  // The builder's Responses section is where this shows up; the list page shows
  // nothing per-response, but revalidating it keeps a stale count honest if one
  // is ever added there.
  revalidatePath(`/forms/${form.id}`);
  revalidatePath("/respond");

  return { ok: true };
}

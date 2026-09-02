import "server-only";

import { createAdminClient } from "@/utils/supabase/admin";

/**
 * P7-66 — HOW MANY ANSWERS ARE ALREADY BEHIND THIS FORM.
 *
 * The number both locks in `updateFormSettings` turn on: the reference prefix
 * locks once a request quotes it, and the PURPOSE locks once anything has been
 * submitted at all. Read once, used twice, so the two can never disagree about
 * whether a form is live.
 *
 * ⚠️⚠️ COUNTED THROUGH THE SERVICE ROLE, AND THAT IS THE FIX FOR A HOLE THAT
 * WAS ALREADY OPEN. It used to count through the CALLER's client.
 *
 * CLAUDE.md's first rule: a failing POLICY returns ZERO ROWS; a missing GRANT
 * returns `permission denied`. Both count policies are
 * `vizserve_pms_manages_department(form.department_id)`, and that is FALSE for
 * a team leader on an UNROUTED form (`department_id is null`) — while
 * `assertCanEditForm` deliberately lets the author of an unrouted form through.
 * So on exactly that form the two counts returned zero AND NO ERROR: the
 * fail-closed branch never fired, the lock never engaged, `purpose` flipped,
 * the CHECK set `is_public` true, and a staff survey was served at
 * /request/<slug> with no session. Reachable, not theoretical.
 *
 * ⚠️ A SECURITY CHECK MUST NOT READ THROUGH A POLICY THAT CAN LEGITIMATELY
 * EXCLUDE THE READER. Authority was established by `assertCanEditForm` above,
 * so "how many answers exist" is a DATA question rather than an access one —
 * the same reasoning app/(app)/admin/events/actions.ts gives for writing its
 * audit rows as the service role. The service role bypasses policies (never
 * privileges), so the number is the real one for every caller who reaches this
 * line, unrouted forms included.
 *
 * ⚠️ NOTHING IS RETURNED TO THE CALLER FROM THIS CLIENT except a count. It
 * reads no row, and the two `head: true` queries are pinned to one `form_id`
 * that `assertCanEditForm` has already vouched for.
 *
 * ⚠️⚠️ PHASE 4b ADDED THE SECOND COUNT HERE, IN THE SAME CHANGE THAT CREATES
 * `vizserve_pms_form_responses` (20260902110000_p7_66_form_responses.sql). NOT
 * AFTER IT — the window between the table existing and this function knowing
 * about it WAS the vulnerability, and it never opened.
 *
 * What it was: `vizserve_pms_requests` used to be the only table a submission
 * could land in, so it was the whole count. An EMPLOYEE_ENGAGEMENT form never
 * produces a request — its answers go to `vizserve_pms_form_responses`. So the
 * moment that table shipped, a pulse survey with hundreds of staff answers
 * would still have counted ZERO here, the purpose lock would never have
 * engaged, and somebody could flip the form to CLIENT_REQUEST — whereupon the
 * live CHECK `is_public = (purpose = 'CLIENT_REQUEST')` sets `is_public` true
 * and the form, with every one of those answers behind it, is answerable at
 * /request/<slug> with no session.
 *
 * `tests/unit/form-purpose-lock.test.ts` is the test of it: a form with
 * responses and zero requests still refuses a purpose change.
 *
 * ⚠️ AND IT FAILS CLOSED. A count that errors is NOT read as zero. Returning a
 * number meant every failure mode of these two queries — a dropped connection,
 * a missing table before the migration is applied, `permission denied` — became
 * "this form has no submissions", which is precisely the state the lock exists
 * to refuse. A security check whose error path is the permissive answer is not
 * a check. So the failure is returned, and `updateFormSettings` refuses the
 * change rather than allowing it on a count it does not have.
 *
 * ⚠️ THE SUM IS EXACT FOR BOTH MESSAGES, and that is a property of the schema
 * rather than luck: a request can only be created through the public form,
 * which requires `is_public`, i.e. CLIENT_REQUEST; a response can only be
 * inserted for a form the RLS policy checks is EMPLOYEE_ENGAGEMENT. The two
 * counts are therefore mutually exclusive — one of them is always zero — so
 * "N submissions" and "N requests quote it" both name the number they mean.
 * Adding a third purpose, or letting one form carry both, breaks that and the
 * two messages have to split.
 */
export type FormSubmissionCount = { ok: true; total: number } | { ok: false; message: string };

export async function countFormSubmissions(
  formId: string,
  /**
   * ⚠️ `includeResponses: false` IS SOUND ONLY ON A CLIENT_REQUEST FORM, and
   * the caller carries that burden. A response can only be inserted for a form
   * `form responses insertable by their author` has checked is
   * EMPLOYEE_ENGAGEMENT, so a client form's response count is known to be zero
   * without asking — which is what lets /forms/[id] keep loading for the four
   * live client forms while 20260902110000_p7_66_form_responses.sql is still
   * unapplied. `updateFormSettings` never passes it: the purpose lock is
   * exactly the place that must not assume which kind of form this is.
   */
  { includeResponses = true }: { includeResponses?: boolean } = {},
): Promise<FormSubmissionCount> {
  // Constructed here rather than passed in, so no caller can hand this function
  // an RLS-scoped client by accident and reopen the under-count above.
  let admin: ReturnType<typeof createAdminClient>;

  try {
    admin = createAdminClient();
  } catch (cause) {
    // `SUPABASE_SECRET_KEY` missing throws. Fail closed, like every other way
    // this can fail to produce a number.
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "the submission count is unavailable",
    };
  }

  const [requests, responses] = await Promise.all([
    admin
      .from("vizserve_pms_requests")
      .select("id", { count: "exact", head: true })
      .eq("form_id", formId),
    includeResponses
      ? admin
          .from("vizserve_pms_form_responses")
          .select("id", { count: "exact", head: true })
          .eq("form_id", formId)
      : { count: 0, error: null },
  ]);

  // Either failing is a refusal. Reported with the Postgres sentence, which on
  // the likeliest failure says `relation "vizserve_pms_form_responses" does not
  // exist` and names the migration that has not been applied yet.
  const failure = requests.error ?? responses.error;
  if (failure) return { ok: false, message: failure.message };

  return { ok: true, total: (requests.count ?? 0) + (responses.count ?? 0) };
}

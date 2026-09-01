import { z } from "zod";

import type { SubmissionResult } from "@/lib/schemas/forms";

/**
 * P7-66 — THE RATE LIMITER MUST SEE THE ATTEMPTS THE SERVER ACTION REFUSES.
 *
 * ⚠️ THIS IS A SECURITY REGRESSION FIX, NOT A TIDY-UP. Read it that way.
 *
 * `vizserve_pms_submit_request` is the ONLY writer of
 * `vizserve_pms_public_submission_log`, and the P1-15 throttle counts rows in
 * that table with no `accepted` filter — so before this phase, a submission the
 * database refused still cost the sender one of their ten hourly attempts. That
 * is what made the limiter work at all: a bot posting rubbish is refused rubbish
 * ten times and then refused outright.
 *
 * Adding a server-side validation gate AHEAD of the RPC quietly removed that
 * property. Every submission the new layer rejects returns before the RPC is
 * reached, so it is invisible to the limiter — and a bot posting valid core
 * fields with an empty `field_values` against a form that has one required field
 * can loop from a single IP for ever without the per-IP or per-email cap ever
 * tripping. The gate that was added to make the endpoint stricter made it
 * unbounded.
 *
 * Two properties are restored here, and the tests pin both:
 *
 *   1. EVERY rejected attempt is recorded, so it counts against the cap.
 *   2. A client who is ALREADY throttled is told they are throttled — not
 *      "please correct the highlighted fields", which is advice they cannot act
 *      on and which the RPC would never have given them.
 *
 * WHY NOT SIMPLY CALL THE RPC ANYWAY on an invalid submission — the obvious fix,
 * and the one that "exactly restores prior behaviour"? Because the two layers
 * are deliberately not identical. The RPC's own loop is documented as "not
 * exhaustive validation", and it reads `vizserve_pms_form_fields`, whose rows
 * are a PROJECTION of `vizserve_pms_forms.schema` rather than the schema itself.
 * Anywhere they disagree — a stricter entity validator, a stale or unprojected
 * row, and on the four live forms every row, because there are none — the RPC
 * ACCEPTS what this layer rejected and MINTS A REFERENCE NUMBER for it. A
 * throwaway call for its logging side effect is not throwaway when the side
 * effect can be a real client request.
 *
 * So the attempt is recorded on its own, through a function that does the
 * counting in the same place and against the same tunables the RPC does. See
 * `20260902090000_p7_66_record_public_submission_rejection.sql`.
 */

/** What the recorder answers: was this sender already over the cap? */
export type RejectionRecord = { throttled: boolean };

/**
 * `{ "throttled": true }` — the whole of the function's jsonb result.
 *
 * Named and parsed rather than read off with a cast, for the reason every other
 * RPC result in this file's neighbourhood is: the shape crosses a process
 * boundary and `data` is `Json`.
 */
const rejectionRecordSchema = z.object({ throttled: z.boolean() });

/**
 * The recorder's `{ data, error }`, classified. Pure, so the branch that decides
 * what a client is told can be tested without a database.
 *
 * ⚠️ IT FAILS OPEN, DELIBERATELY. An unreadable answer means we do not know
 * whether this sender is over the cap, and the two ways to be wrong are not
 * symmetrical: guessing "throttled" tells a paying client on one of four live
 * published forms to stop trying, because OUR function was unavailable. Guessing
 * "not throttled" costs one un-capped attempt during an outage, and the RPC — the
 * authority, which checks the cap itself on every accepted path — still refuses
 * anything valid that arrives while they are genuinely over it.
 */
export function readRejectionRecord(response: {
  data: unknown;
  error: { message: string } | null;
}): RejectionRecord {
  if (response.error) return { throttled: false };

  const parsed = rejectionRecordSchema.safeParse(response.data);

  return parsed.success ? parsed.data : { throttled: false };
}

/** What `validateFieldValues` hands back when it has refused a submission. */
export type SubmissionRejection = {
  fieldErrors: Record<string, string>;
  /** Set when the FORM could not be checked, rather than an answer being wrong. */
  formError?: string;
};

/**
 * The one exit from a refused submission, and the reason it is a function rather
 * than three lines inline: the ORDER is the fix.
 *
 * The attempt is recorded FIRST and UNCONDITIONALLY — before anything is decided
 * about what to say — so there is no branch through this function that returns
 * without the limiter having seen it. A `formError` counts too: an unreadable
 * schema is still a request somebody sent, and it is the cheapest one to send in
 * a loop.
 *
 * Then, and only then, the throttle answer outranks the field errors. A sender
 * already over the cap gets `rate_limited`, which the browser renders as "Too
 * many submissions from here in the last hour" — the same sentence the RPC would
 * have produced, and the only one that is true for them. Handing them
 * "Please correct the highlighted fields" invites the correction that will also
 * be refused.
 *
 * ⚠️ A RECORDER THAT THROWS MUST NOT BECOME A 500. This sits behind an endpoint
 * with no session; `createAdminClient()` throws outright when the service key is
 * missing, and a missing key is a deployment fault, not a reason to hand the
 * public a stack trace instead of their field errors. Caught here rather than
 * only in the caller, so the guarantee belongs to the function the test drives.
 */
export async function rejectSubmission(
  rejection: SubmissionRejection,
  record: () => Promise<RejectionRecord>,
): Promise<SubmissionResult> {
  let throttled = false;

  try {
    ({ throttled } = await record());
  } catch (error) {
    console.error("[submit] rejected attempt could not be recorded —", error);
  }

  if (throttled) return { ok: false, error: "rate_limited" };

  // No `field_errors` when the form itself is what could not be checked: there
  // is no field to point at, and the detail is ours — the requester is
  // unauthenticated. The browser falls through to "Something went wrong."
  if (rejection.formError) return { ok: false, error: "validation_failed" };

  return { ok: false, error: "validation_failed", field_errors: rejection.fieldErrors };
}

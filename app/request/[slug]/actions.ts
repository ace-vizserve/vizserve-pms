"use server";

import { headers } from "next/headers";

import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { sendRequestSubmittedEmail } from "@/lib/email/client-emails";
import { generateStatusToken, hashStatusToken, statusUrl } from "@/lib/request-status";
import { uploadPendingAttachment, type UploadResult } from "@/lib/attachments-server";
import { readPublicFormResponse, type PublicFormLookup } from "@/lib/form-builder/public-lookup";
import { validateFieldValues, type FieldValues } from "@/lib/form-builder/values";
import {
  readRejectionRecord,
  rejectSubmission,
  type RejectionRecord,
} from "@/lib/public-submission-limit";
import {
  attachmentRefSchema,
  submissionResultSchema,
  type SubmissionResult,
} from "@/lib/schemas/forms";
import { z } from "zod";

/**
 * P1-07 — submission.
 *
 * ⚠️ P7-66 — THIS ACTION NOW VALIDATES, and it used to say in this very comment
 * that it did not ("a courier, not a validator"). The reason it did not was
 * sound: duplicating the rules here would create a second place for them to
 * drift from `vizserve_pms_submit_request`. What changed is that there is no
 * longer a second copy to drift — `lib/form-builder/values.ts` runs the SAME
 * entity declarations the browser renders from, which are a verbatim port of the
 * `buildFieldSchema` branches the database function's loop mirrors. One rule
 * set, three places it runs.
 *
 * ⚠️ THE DATABASE STILL VALIDATES TOO, THROUGH THIS PHASE, DELIBERATELY. The
 * RPC's own per-field loop is untouched, so submissions are double-checked and
 * this can sit in production for days before Phase 5 strips the older layer and
 * revokes `anon`'s execute. Until it does, a `curl` straight at the RPC is still
 * refused by Postgres — which is the whole reason the old layer is removed
 * SECOND rather than first.
 *
 * ⚠️ AND BECAUSE IT VALIDATES, IT MUST ALSO THROTTLE. The P1-15 cap counts rows
 * in `vizserve_pms_public_submission_log`, which only the RPC writes — so a
 * validation gate that returns BEFORE the RPC hides every refused attempt from
 * the limiter and leaves the endpoint unbounded. That is a regression this
 * action introduced and `lib/public-submission-limit.ts` closes: the refusal
 * path records the attempt itself, and reports `rate_limited` ahead of the field
 * errors when the sender is already over the cap.
 *
 * The honeypot is the one check that has always belonged here — it is a property
 * of the rendered HTML, not of the data model.
 */

const submitInputSchema = z.object({
  slug: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  attachments: z.array(attachmentRefSchema).default([]),
  honeypot: z.string().optional(),
});

function clientIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headerList.get("x-real-ip");
}

type PublicClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The form's schema, as the SERVER sees it.
 *
 * ⚠️ RE-READ FROM THE DATABASE, NEVER TAKEN FROM THE BROWSER. The whole value of
 * validating here is that this endpoint has no session and anyone on the
 * internet can post to it: a schema supplied by the caller would let them
 * declare every field optional and validate their own submission against it.
 *
 * `vizserve_pms_get_public_form` is the only door — `anon` holds no table
 * privileges at all (CLAUDE.md), so the SECURITY DEFINER function is how this
 * process reads a form, exactly as the page does. Its `where` clause is
 * `slug and is_public and is_active`, character for character the lookup
 * `vizserve_pms_submit_request` performs, so a `closed` answer here and
 * `form_not_found` there are the same condition rather than two that usually
 * agree — which is exactly why a fault that is NOT that condition must not
 * borrow its wording. See `PublicFormLookup`.
 */
async function loadPublicFormSchema(
  supabase: PublicClient,
  slug: string,
): Promise<PublicFormLookup> {
  const { data, error } = await supabase.rpc("vizserve_pms_get_public_form", { p_slug: slug });

  // ⚠️ THREE ANSWERS, NOT TWO. Classified in `readPublicFormResponse`, which is
  // pure and tested: a `null` schema here used to mean "closed", "we could not
  // read it" and "it did not parse" alike, and all three came out of the action
  // as `form_not_found` — "This form is no longer accepting submissions." for
  // what was often a passing network fault.
  return readPublicFormResponse({ data, error });
}

/**
 * The `field_values` bag out of a payload that is `Record<string, unknown>`.
 *
 * `Object.hasOwn` rather than a bare read, on the rule values.ts states: a
 * payload is attacker-shaped JSON, and `payload.constructor` answers with a
 * function on any plain object. Anything that is not a plain object becomes an
 * empty bag, which is then refused by the required-field rules rather than
 * crashing the translation.
 */
function readFieldValues(payload: Record<string, unknown>): FieldValues {
  const raw = Object.hasOwn(payload, "field_values") ? payload.field_values : undefined;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  return raw as FieldValues;
}

export async function submitPublicRequest(input: unknown): Promise<SubmissionResult> {
  const parsed = submitInputSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: "validation_failed" };
  }

  // Honeypot: a hidden field no human fills. Report success to a bot rather
  // than an error — a bot that learns it was detected just adapts.
  if (parsed.data.honeypot && parsed.data.honeypot.trim() !== "") {
    return { ok: true, request_id: crypto.randomUUID(), reference_no: "PENDING" };
  }

  const headerList = await headers();
  const supabase = await createClient();

  const form = await loadPublicFormSchema(supabase, parsed.data.slug);

  if (form.status === "closed") {
    return { ok: false, error: "form_not_found" };
  }

  if (form.status === "unavailable") {
    /*
     * ⚠️ RETRYABLE, AND DELIBERATELY NOT `form_not_found`. The browser has no
     * branch for this code without field errors, so it falls through to
     * "Something went wrong. Please try again." — which is what a client saw
     * for a transient fault before the schema was read here at all, and the
     * only advice that is true when the form itself is fine.
     *
     * The reason is logged, never returned: the requester is unauthenticated.
     */
    console.error(`[submit] ${parsed.data.slug}: form could not be read — ${form.reason}`);

    /*
     * ⚠️ AND THE LIMITER SEES IT, FOR THE SAME REASON THE FIELD-ERROR BRANCH
     * BELOW DOES. This used to `return` straight out, which is the exact hole
     * `lib/public-submission-limit.ts` was written to close: the RPC is the
     * only thing that writes `vizserve_pms_public_submission_log`, so a refusal
     * that never reaches it is a POST that costs the sender nothing and leaves
     * no trace. P1-15 then counts zero however many arrive.
     *
     * It is REACHABLE ON A LIVE FORM, which is what makes it worth the four
     * lines: `loadPublicFormSchema` returns `unavailable` when
     * `vizserve_pms_get_public_form` errors or its payload stops parsing — a
     * new `vizserve_pms_field_type` enum value the app does not know yet, an
     * attachment rule with a null column — for a form that is published and
     * whose URL is in a client's inbox. Before P7-66 read the schema here, that
     * same request reached the RPC and WAS logged; this restores it.
     *
     * `formError` rather than field errors: there is no field to point at, and
     * the sentence the browser shows is unchanged.
     */
    return rejectSubmission({ fieldErrors: {}, formError: form.reason }, () =>
      recordRejectedSubmission(parsed.data.slug, clientIp(headerList), parsed.data.payload),
    );
  }

  const schema = form.schema;

  /*
   * P7-66 — the per-field rules, run server-side against the schema just read.
   *
   * Field-keyed in and field-keyed out: the entity-id translation is entirely
   * inside `validateFieldValues` (§1), so this action never learns that the
   * library keys anything by UUID. `field_errors` is therefore already in the
   * shape `submissionResultSchema` promises the browser, and the browser already
   * routes it by `field_key`.
   *
   * ⚠️ THE VALIDATED VALUES REPLACE THE SUBMITTED ONES. They are the zod
   * output — trimmed, coerced, empty optionals dropped — which is what the old
   * browser-side `buildSubmissionSchema` produced before posting. Passing the
   * raw ones on would store an untrimmed answer under a form that has always
   * trimmed.
   */
  const checked = await validateFieldValues(schema, readFieldValues(parsed.data.payload));

  if (!checked.ok) {
    if (checked.formError) {
      // The form itself is unreadable, not the answer. No detail goes back: the
      // requester is unauthenticated and the detail is ours.
      console.error(`[submit] ${parsed.data.slug}: form schema could not be checked`);
    }

    /*
     * ⚠️ THE LIMITER SEES THIS ATTEMPT, AND THAT IS THE POINT OF THE DETOUR.
     *
     * Returning straight from here — which is what this branch did when it was
     * added — hides every refused submission from P1-15, because the RPC below
     * is the only thing that writes `vizserve_pms_public_submission_log` and the
     * throttle counts rows there. See `lib/public-submission-limit.ts` for why
     * the attempt is recorded on its own rather than by calling the RPC anyway.
     */
    return rejectSubmission(checked, () =>
      recordRejectedSubmission(parsed.data.slug, clientIp(headerList), parsed.data.payload),
    );
  }

  const { data, error } = await supabase.rpc("vizserve_pms_submit_request", {
    p_slug: parsed.data.slug,
    p_payload: { ...parsed.data.payload, field_values: checked.values } as never,
    p_attachments: parsed.data.attachments as never,
    p_ip: clientIp(headerList),
  });

  if (error) {
    return { ok: false, error: "validation_failed" };
  }

  const result = submissionResultSchema.safeParse(data);
  if (!result.success) return { ok: false, error: "validation_failed" };
  if (!result.data.ok) return result.data;

  const trackingUrl = await issueTrackingLink(result.data.request_id, result.data.reference_no);

  await acknowledge(result.data.request_id, result.data.reference_no, trackingUrl);

  // Handed back so the browser can put it in the EmailJS parameters too —
  // the raw token exists only here and is never stored, so this is the one
  // moment it can be passed on.
  return { ...result.data, status_url: trackingUrl ?? undefined };
}

/**
 * P1-15 / P7-66 — log a submission this process refused, and ask whether the
 * sender was already over the cap.
 *
 * SERVICE ROLE, and NOT reachable by `anon`. `vizserve_pms_submit_request` is
 * granted to `anon` because a browser has to be able to call it; this one is
 * not, and must not be — it writes a row keyed by IP and email, so an
 * anonymous caller with execute on it could fill a competitor's bucket and
 * lock a legitimate client out of a live form for an hour. The only caller is
 * this action, which already holds the service key.
 *
 * ⚠️ THE SQL FUNCTION IS UNAPPLIED AT THE TIME OF WRITING (see the migration).
 * Until it is applied the RPC comes back with an error, `readRejectionRecord`
 * fails open, and the caller returns the field errors exactly as it does today
 * — a degraded limiter, not a broken form.
 */
async function recordRejectedSubmission(
  slug: string,
  ip: string | null,
  payload: Record<string, unknown>,
): Promise<RejectionRecord> {
  // `Object.hasOwn`, on the rule values.ts states: the payload is attacker-shaped
  // JSON and a bare read answers from the prototype. The database btrims and
  // nullifies it, so anything that is not a string is simply "no email" — which
  // leaves the per-IP half of the cap doing the work, as it does for a
  // submission that genuinely omits one.
  const rawEmail = Object.hasOwn(payload, "requester_email")
    ? payload.requester_email
    : undefined;

  const response = await createAdminClient().rpc(
    "vizserve_pms_record_public_submission_rejection",
    {
      p_slug: slug,
      p_ip: ip,
      p_email: typeof rawEmail === "string" ? rawEmail : null,
    },
  );

  if (response.error) {
    console.error(`[submit] ${slug}: rejected attempt not logged — ${response.error.message}`);
  }

  return readRejectionRecord(response);
}

/**
 * P7-51 — mint the tracking token and store only its hash.
 *
 * ⚠️ THE RAW TOKEN IS RETURNED AND NEVER PERSISTED. The column holds a
 * SHA-256; a dump of `vizserve_pms_requests` yields nothing replayable against
 * the status endpoint. Same rule as P4's approval tokens.
 *
 * Issued HERE rather than inside `vizserve_pms_submit_request` for two
 * reasons: that function is the authority on validation and should not grow a
 * second job, and a token generated in Postgres would have to be returned
 * through its jsonb result — which is logged in more places than a value that
 * grants read access should ever appear.
 *
 * Returns null on any failure. A request without a tracking link is a slightly
 * worse email; a submission that fails because a token could not be minted is
 * a lost job.
 */
async function issueTrackingLink(
  requestId: string,
  referenceNo: string,
): Promise<string | null> {
  try {
    const token = generateStatusToken();

    const { error } = await createAdminClient()
      .from("vizserve_pms_requests")
      .update({ status_token_hash: hashStatusToken(token) })
      .eq("id", requestId);

    if (error) {
      console.error(`[submit] ${referenceNo}: tracking token not stored — ${error.message}`);
      return null;
    }

    return statusUrl(token);
  } catch (error) {
    console.error(`[submit] ${referenceNo}: tracking token threw —`, error);
    return null;
  }
}

/**
 * P7-47 — tell the requester their request arrived.
 *
 * WHY THIS READS THE ROW BACK rather than using what was posted: the payload is
 * dynamic (D20), so the field carrying the email is named differently on every
 * form. `vizserve_pms_submit_request` is what resolves it into the typed
 * `requester_email` column, so the database is the only place that knows the
 * answer for certain.
 *
 * SERVICE ROLE, and it is safe precisely because of what is being read: the row
 * this call just created, by the id the function just returned. `anon` holds no
 * table privileges at all (CLAUDE.md), so the caller's own client cannot read
 * it back — and giving `anon` a policy that could would open every request to
 * anybody who could guess a uuid.
 *
 * NOT SENT THROUGH THE OUTBOX, for the structural reason the templates file
 * gives: the outbox joins notifications to `vizserve_pms_users` for an address,
 * and a client has no user row. Same direct-send path the Gate 1 decision
 * emails use.
 *
 * ⚠️ EVERY FAILURE HERE IS SWALLOWED, deliberately. The request is COMMITTED by
 * the time this runs. Reporting an email failure to the submitter would tell
 * them their request did not go through when it did, and they would send it
 * again — turning a missing email into a duplicate job somebody has to find and
 * close. It is logged for whoever is on support instead.
 */
async function acknowledge(
  requestId: string,
  referenceNo: string,
  trackingUrl: string | null,
): Promise<void> {
  try {
    const admin = createAdminClient();

    const { data: request } = await admin
      .from("vizserve_pms_requests")
      .select("requester_name, requester_email, title")
      .eq("id", requestId)
      .maybeSingle();

    if (!request) {
      console.error(`[submit] ${referenceNo}: acknowledgement skipped — request not readable`);
      return;
    }

    const outcome = await sendRequestSubmittedEmail({
      statusUrl: trackingUrl,
      to: request.requester_email,
      requesterName: request.requester_name,
      referenceNo,
      title: request.title,
    });

    if (outcome.status === "failed") {
      console.error(`[submit] ${referenceNo}: acknowledgement failed — ${outcome.error}`);
    }
  } catch (error) {
    // A throw here — a missing service key, a network fault — must not surface
    // as a failed submission. See the header.
    console.error(`[submit] ${referenceNo}: acknowledgement threw —`, error);
  }
}

/**
 * P1-09 — one file, uploaded before the form is submitted.
 *
 * Public and unauthenticated, like the form it serves. Everything that makes
 * that safe — the size ceiling, the MIME allowlist, the magic-number check, the
 * per-IP throttle — lives in `uploadPendingAttachment`, because this is the last
 * point at which the real bytes exist.
 *
 * Takes FormData rather than a plain object: a File does not survive being
 * spread into one.
 */
export async function uploadPublicAttachment(formData: FormData): Promise<UploadResult> {
  const formId = formData.get("form_id");
  const fieldKey = formData.get("field_key");
  const file = formData.get("file");

  if (typeof formId !== "string" || !(file instanceof File)) {
    return { ok: false, error: "Nothing was uploaded." };
  }

  return uploadPendingAttachment({
    formId,
    fieldKey: typeof fieldKey === "string" && fieldKey !== "" ? fieldKey : null,
    file,
    uploadedBy: null,
  });
}

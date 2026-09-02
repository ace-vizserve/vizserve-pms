"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertDepartmentAccess, ForbiddenError, requireRole } from "@/lib/auth/authorization";
import type { Json } from "@/lib/database.types";
import {
  FormSchemaError,
  parseFormSchema,
  type FormSchemaRejection,
} from "@/lib/form-builder/schema";
import { createClient } from "@/utils/supabase/server";
import {
  FORM_PURPOSE_LABELS,
  formCreateSchema,
  formSettingsSchema,
  isPublicForPurpose,
  nextCandidate,
  prefixFromName,
  slugFromName,
  type FormAudience,
} from "@/lib/schemas/forms";

import { responsesCsvFilename, responsesToCsv } from "@/lib/form-builder/csv";
import { formatDateTime, todayInAppZone } from "@/lib/dates";
import { reconcileFormSchema, optionsFromRow, type FormFieldRow } from "@/lib/form-builder/schema";
import type { FieldType } from "@/lib/schemas/forms";

import { countFormSubmissions } from "./submission-count";

/**
 * P1-03 / P1-04 — form builder and settings mutations.
 *
 * Every action re-establishes authority through lib/auth/authorization.ts
 * rather than trusting the caller, and RLS re-checks underneath. A TL may only
 * touch forms for departments they actually lead — holding the role is not
 * enough (D15).
 */

export type ActionResult<T = void> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** Postgres unique_violation — surfaced as a field error, not a 500. */
function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
}

/**
 * Which unique constraint fired.
 *
 * Forms now have two: the slug and the reference prefix. Mapping every 23505 to
 * "that URL slug is taken" was fine when there was one, and became a confusing
 * lie the moment the prefix gained an index — the user would be told to change a
 * field that was not the problem.
 *
 * The prefix constraint matters more than it looks: it is what stops two forms
 * generating the same COL-2026-0001, which surfaced as a raw 500 on the PUBLIC
 * form rather than an error anyone here would see.
 */
function uniqueFieldError(error: { message?: string; details?: string } | null): {
  field: "slug" | "reference_prefix";
  message: string;
  error: string;
} {
  const haystack = `${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase();

  if (haystack.includes("reference_prefix")) {
    return {
      field: "reference_prefix",
      message: "Already used by another form.",
      error: "That reference prefix belongs to another form.",
    };
  }

  return { field: "slug", message: "Already in use.", error: "That URL slug is taken." };
}

async function assertCanEditForm(formId: string) {
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  const { data: form } = await supabase
    .from("vizserve_pms_forms")
    // `reference_prefix`, `purpose` and `is_anonymous` so `updateFormSettings`
    // can tell a change from a resubmission of the same value — the three locks
    // below must not fire on a Save that touched something else entirely.
    .select("id, department_id, created_by, reference_prefix, purpose, is_anonymous")
    .eq("id", formId)
    .maybeSingle();

  if (!form) throw new ForbiddenError("That form does not exist, or is outside your scope.");

  // An unrouted draft belongs to its author until a department is chosen.
  if (form.department_id === null && form.created_by === context.userId) {
    return { context, supabase, form };
  }

  assertDepartmentAccess(context, form.department_id);
  return { context, supabase, form };
}

/**
 * P7-66 — ⚠️ ANONYMITY IS MEANINGLESS ON A CLIENT FORM, AND SAYING SO IS WORSE
 * THAN MEANINGLESS.
 *
 * /request/<slug> has no session at all: a client TYPES their own name and email
 * into the form, and those are ordinary answers on the request rather than an
 * identity the platform captured. There is nothing to withhold — a client form
 * flagged anonymous would promise something it does not deliver, with the name
 * sitting in `requester_name` the whole time.
 *
 * `vizserve_pms_forms_anonymous_is_internal` is the enforcement and refuses the
 * row. This is the sentence in front of it, and it is SHARED BY BOTH WRITE
 * PATHS deliberately: `updateFormSettings` had it and `createForm` did not, so
 * the same illegal pair produced a readable field error on one screen and a raw
 * `23514 violates check constraint` — which falls straight past
 * `isUniqueViolation`, unanchored to any field — on the other.
 *
 * Returns the refusal or null, rather than throwing: both callers already
 * return `ActionResult`, and a thrown error here would need a catch that
 * neither has.
 */
function anonymityPurposeRefusal(
  purpose: string,
  isAnonymous: boolean,
): ActionResult<never> | null {
  if (!isAnonymous || purpose !== "CLIENT_REQUEST") return null;

  return {
    ok: false,
    error: "A client form cannot be anonymous.",
    fieldErrors: {
      is_anonymous: [
        "A client types their own name into the form, so there is no identity to withhold.",
      ],
    },
  };
}

/**
 * P7-66 Phase 5 — ⚠️ AN INTERNAL FORM IS AN ADMIN INSTRUMENT, END TO END.
 *
 * Ace, 2 Sep 2026, on why: a team leader cannot read the members of a department
 * they do not lead, so Phase 6’s "who has not answered" roster would be
 * half-blank on exactly the company-wide survey it is most wanted for. Widening
 * `users read managed departments` to fix that would have made the WHOLE APP’s
 * people data wider; restricting internal forms to admins costs nothing, because
 * an admin already reads every department.
 *
 * ⚠️ THIS IS THE READABLE REFUSAL, NOT THE ENFORCEMENT. `forms insertable by
 * team leaders`, `forms updatable in scope` and `form fields follow their form`
 * all carry the same rule as of 20260902140000, and the last of those is the one
 * that matters most: `vizserve_pms_save_form_schema` is SECURITY INVOKER and
 * writes the field rows directly, so a lock on the form row alone would leave
 * every question on it still editable. The front end will be bypassed; the
 * policies will not.
 *
 * Client forms are not mentioned because nothing about them changes.
 */
function internalAdminRefusal(
  role: string,
  purpose: string,
): ActionResult<never> | null {
  if (purpose !== "INTERNAL" || role === "admin") return null;

  return {
    ok: false,
    error: "Only an admin can create or change an internal form.",
    fieldErrors: {
      purpose: [
        "Internal forms are managed by admins, because their answers are read across departments. Ask an admin to set this one up.",
      ],
    },
  };
}

/**
 * P7-66 Phase 5 — THE AUDIENCE WRITE, WHICH IS ITS OWN TRANSACTION.
 *
 * ⚠️ NOT PART OF THE `.update()` ABOVE IT, AND THAT IS NOT AN OVERSIGHT. The
 * audience is two facts in two tables — a flag on the form and a row per
 * department — and setting one without the other CHANGES WHO MAY ANSWER. Two
 * PostgREST calls are two transactions, so the pair is written by
 * `vizserve_pms_set_form_audience`, which does both or neither.
 *
 * ⚠️ IT RUNS AFTER THE SETTINGS UPDATE, ON PURPOSE. If this fails, the settings
 * are saved and the audience is exactly what it was — a partial save the person
 * is told about, with the stored audience still valid. The other order would
 * leave a new audience attached to a form whose settings did not land.
 */
async function writeFormAudience(
  supabase: Awaited<ReturnType<typeof createClient>>,
  formId: string,
  audience: FormAudience,
): Promise<ActionResult<never> | null> {
  const { error } = await supabase.rpc("vizserve_pms_set_form_audience", {
    p_form_id: formId,
    p_all: audience.is_all_departments,
    p_department_ids: audience.department_ids,
  });

  if (!error) return null;

  /*
   * ⚠️ THE MESSAGE SAYS WHAT DID LAND. This is the one path here that saves
   * something and still fails, and "could not save" over a form whose name has
   * just changed is the kind of sentence that gets a change made twice.
   */
  return {
    ok: false,
    error:
      "The settings were saved, but who should answer this form was not changed — " +
      `it is still whatever it was before. Try that part again. ${error.message}`,
    fieldErrors: { audience: [error.message] },
  };
}

/**
 * P7-29 — the slug and the reference prefix are DERIVED when left blank.
 *
 * Both are globally unique and both were empty boxes somebody had to invent a
 * value for. That is how the live form ended up called "Test Client Request"
 * while issuing references reading `COL-`.
 *
 * DE-DUPLICATION IS A RETRY, NOT A LOOKUP, and that is the important part. RLS
 * scopes `vizserve_pms_forms` to the departments somebody leads, so a
 * "is this slug taken" query would be blind to exactly the clashes that matter
 * — another department's form, which is invisible here and unique-indexed all
 * the same. So the insert is attempted, and Postgres is the thing that answers.
 *
 * ⚠️ ONLY A DERIVED VALUE IS EVER BUMPED. If somebody TYPED `collateral` and it
 * is taken, they are told so. Quietly saving `collateral-2` would hand them an
 * address one character away from another department's form, which they are
 * about to paste into an email.
 */
export async function createForm(input: unknown): Promise<ActionResult<{ id: string }>> {
  const context = await requireRole("team_leader");
  const parsed = formCreateSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  if (parsed.data.department_id) {
    assertDepartmentAccess(context, parsed.data.department_id);
  }

  // P7-66 — checked here as well as on the settings card. The card clears the
  // flag when the purpose changes and hides the switch on a client form; this is
  // what holds when the card is bypassed, and it is the difference between a
  // field error and a raw CHECK-constraint message.
  const anonymityRefusal = anonymityPurposeRefusal(
    parsed.data.purpose,
    parsed.data.is_anonymous,
  );
  if (anonymityRefusal) return anonymityRefusal;

  /*
   * P7-66 Phase 5 — and only an admin may create the internal kind. Checked on
   * both write paths for the same reason anonymity is: `forms insertable by
   * team leaders` refuses the row either way, but as a raw
   * `new row violates row-level security policy`, which is anchored to no field
   * and actionable by nobody.
   */
  const adminRefusal = internalAdminRefusal(context.role, parsed.data.purpose);
  if (adminRefusal) return adminRefusal;

  const supabase = await createClient();

  /*
   * ⚠️ `audience` IS NOT A COLUMN, so it is lifted off before the row is built.
   * It is a flag plus a row per department in another table, written by
   * `vizserve_pms_set_form_audience` — see `writeFormAudience`. Destructured
   * rather than deleted so the type system keeps checking that nothing else
   * strays into the insert.
   */
  const { audience, ...formRow } = parsed.data;

  /*
   * ⚠️ REFUSED ON CREATE RATHER THAN SILENTLY DROPPED, and the difference
   * matters more here than the feature does.
   *
   * The create card has no audience control: `/forms/new` asks an internal form
   * for a name and nothing else, by design, and the audience is chosen in
   * Settings once there is a form to narrow. So this is unreachable through the
   * UI — but a caller who sent one and got `{ ok: true }` back would have been
   * told their narrowing was saved when the form is open to the whole company.
   * A discarded audience is the one kind of discard that cannot be allowed to
   * look like success.
   *
   * It could not be honoured even if it were wanted: the form has no id until
   * the insert below returns, so the audience write could not share its
   * transaction — which is the entire reason
   * `vizserve_pms_set_form_audience` exists.
   */
  if (audience) {
    return {
      ok: false,
      error: "Create the form first, then choose who should answer it.",
      fieldErrors: {
        audience: ["Set on the Settings tab, once the form exists."],
      },
    };
  }

  // Blank means "derive it". Remembered as a fact about the REQUEST, because it
  // is what decides whether a clash may be resolved silently or has to be
  // reported to the person who typed the value.
  const derivedSlug = parsed.data.slug === "";
  const derivedPrefix = parsed.data.reference_prefix === "";

  const slugStem = slugFromName(parsed.data.name);
  const prefixStem = prefixFromName(parsed.data.name);

  let slug = derivedSlug ? slugStem : parsed.data.slug;
  let reference_prefix = derivedPrefix ? prefixStem : parsed.data.reference_prefix;

  // P7-66 — no dual-write here, deliberately, and for one reason only: a new
  // form has no field rows, so the blob to derive is the empty one, and the
  // `schema` column's default `{"entities": {}, "root": []}` IS what
  // `schemaFromFields([])` produces. There is nothing for a sync to write that
  // the insert has not already written.
  //
  // Bounded. An unbounded retry against a unique index is a way to hold a
  // connection open for a very long time; twenty distinct names for one form is
  // already past the point where the person should be choosing one themselves.
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const { data, error } = await supabase
      .from("vizserve_pms_forms")
      .insert({
        ...formRow,
        slug,
        reference_prefix,
        /*
         * ⚠️ P7-66 — DERIVED HERE, NEVER SENT. `is_public` is off both zod
         * schemas precisely so this line is the only thing that decides it, and
         * `vizserve_pms_forms_purpose_matches_public` refuses the row if it is
         * ever wrong. Getting it wrong the other way — an internal form
         * inserted with `is_public = true` — would put a staff form on the open
         * internet at /request/<slug>, because the public lookup filters on
         * `is_public and is_active` and has never heard of `purpose`.
         */
        is_public: isPublicForPurpose(parsed.data.purpose),
        created_by: context.userId,
      })
      .select("id")
      .single();

    if (!error) {
      revalidatePath("/forms");
      return { ok: true, data: { id: data.id } };
    }

    if (!isUniqueViolation(error)) return { ok: false, error: error.message };

    const clash = uniqueFieldError(error);

    if (clash.field === "slug" && derivedSlug) {
      slug = nextCandidate(slugStem, attempt + 1);
      continue;
    }

    if (clash.field === "reference_prefix" && derivedPrefix) {
      reference_prefix = nextCandidate(prefixStem, attempt + 1, "");
      continue;
    }

    // A value somebody typed. Theirs to change.
    return { ok: false, error: clash.error, fieldErrors: { [clash.field]: [clash.message] } };
  }

  return {
    ok: false,
    error: "Could not find a free URL slug or reference prefix for that name. Set them by hand.",
  };
}

export async function updateFormSettings(formId: string, input: unknown): Promise<ActionResult> {
  const { context, supabase, form } = await assertCanEditForm(formId);
  // NOT `formCreateSchema`. A blank slug means "derive one" on a form that does
  // not exist yet; on this one it would take away a URL somebody has shared.
  const parsed = formSettingsSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  // Moving a form into a department you do not lead would hand your queue to
  // someone else, so the destination is checked as well as the origin.
  if (parsed.data.department_id) {
    assertDepartmentAccess(context, parsed.data.department_id);
  }

  /*
   * ⚠️ P7-29 — THE PREFIX LOCKS ONCE THE FORM HAS ISSUED A REFERENCE.
   *
   * `COL-2026-0001` is in the client's inbox and is what they quote back.
   * Changing `COL` orphans it from its own series, and nothing anywhere records
   * what the prefix used to be — the reference is reconstructed from the form,
   * so the old ones simply stop matching. Same shape as `field_key`
   * immutability (D20/R5), and the same reason it is a rule rather than a
   * disabled input: the front end will be bypassed.
   */
  /*
   * ⚠️ P7-66 — AND SO DOES THE PURPOSE, FOR THE SAME REASON ONE LEVEL UP.
   *
   * Turning a client form into an internal form would flip `is_public` to
   * false under a URL clients hold, take away the Gate 1 route that every one
   * of its live requests is sitting on, and orphan the reference series the
   * prefix lock exists to protect. The reverse is worse: a form built for staff
   * becomes readable at /request/<slug> by anybody with the link, along with
   * whatever its questions ask for.
   *
   * ⚠️ THE LOCK IS NOT THE ONLY THING STANDING BETWEEN A STAFF FORM AND THE
   * PUBLIC INTERNET, AND IT NEVER WAS. `purpose` is REQUIRED on
   * `formSettingsSchema` — no default — so a payload that omits it is rejected
   * outright rather than silently read as CLIENT_REQUEST. That is the guard
   * that held on an internal form with zero requests, which was every
   * internal form until Phase 4b shipped. See the schema.
   *
   * P7-66 Phase 4b: `countFormSubmissions` now counts staff responses as well
   * as requests, so the lock engages on an internal form too — and it fails
   * closed if it cannot count.
   *
   * The count is read ONCE for both locks — see `countFormSubmissions`.
   */
  /*
   * ⚠️ P7-66 — AND SO DOES ANONYMITY, AND IT IS THE ONE WHOSE LOCK PROTECTS A
   * PROMISE RATHER THAN DATA.
   *
   * The other two locks stop a reference series being orphaned and a route
   * being taken away. This one stops a sentence being made untrue after the
   * fact. NAMED → ANONYMOUS is the dangerous direction and the one that reads
   * as a feature: thirty answers already carry a name, the flag hides the
   * column, and the form then says "anonymous" over data that is not — still
   * exported, still readable by anyone with SQL. ANONYMOUS → NAMED is the
   * gentler half and still wrong: it changes the promise for the
   * thirty-first person on a form the first thirty are still looking at.
   *
   * `vizserve_pms_forms_anonymity_lock` is the enforcement and refuses both
   * directions. This is the readable refusal in front of it — a `restrict_
   * violation` reaching a person as a raw Postgres sentence is a screen saying
   * nothing they can act on.
   */
  const purposeChanged = parsed.data.purpose !== form.purpose;
  const prefixChanged = parsed.data.reference_prefix !== form.reference_prefix;
  const anonymityChanged = parsed.data.is_anonymous !== form.is_anonymous;

  /*
   * ⚠️ CHECKED BEFORE THE COUNT, because it is true or false on its own and a
   * failing count must not be able to let it through — ordering it after would
   * make an unreachable database a way past the rule.
   *
   * Reachable without anybody trying: the switch is hidden on a client form and
   * react-hook-form KEEPS a hidden field's value, so setting a draft anonymous
   * and then changing its purpose sends `{ purpose: CLIENT_REQUEST,
   * is_anonymous: true }`. The card clears the flag when the purpose changes;
   * this is what holds when the card is bypassed.
   */
  const anonymityRefusal = anonymityPurposeRefusal(
    parsed.data.purpose,
    parsed.data.is_anonymous,
  );
  if (anonymityRefusal) return anonymityRefusal;

  /*
   * P7-66 Phase 5 — ⚠️ BOTH THE OLD PURPOSE AND THE NEW ONE, which is why this
   * is two calls and not one.
   *
   * `form.purpose` stops a non-admin editing a form that IS internal.
   * `parsed.data.purpose` stops them turning a client form they legitimately
   * manage INTO an internal one — a conversion the purpose lock below only
   * refuses once the form has submissions, and which is therefore wide open on
   * a fresh client draft. The policy tests both for the same reason.
   *
   * Before the count, like the anonymity refusal above and for the same reason:
   * it is true or false on its own, and an unreachable database must not become
   * a way past it.
   */
  const adminRefusal =
    internalAdminRefusal(context.role, form.purpose) ??
    internalAdminRefusal(context.role, parsed.data.purpose);
  if (adminRefusal) return adminRefusal;

  /*
   * ⚠️ AN AUDIENCE ON A CLIENT FORM IS NOT A PERMISSIONS QUESTION, IT IS A
   * MEANINGLESS ONE. A client answers from their inbox with no account and no
   * department, so there is no set of departments that could describe them.
   * `vizserve_pms_set_form_audience` refuses it too; this is the sentence in
   * front of that, and it fires before anything is written rather than after the
   * settings have already landed.
   */
  if (parsed.data.audience && parsed.data.purpose !== "INTERNAL") {
    return {
      ok: false,
      error: "A client form has no audience.",
      fieldErrors: {
        audience: [
          "A client answers from their inbox, with no account and no department to belong to.",
        ],
      },
    };
  }

  if (purposeChanged || prefixChanged || anonymityChanged) {
    const counted = await countFormSubmissions(formId);

    /*
     * ⚠️ COULD NOT COUNT ⇒ DO NOT CHANGE. The alternative — carry on with zero
     * — is the whole hole this phase closed, reopened by a network blip. Only
     * the two locked fields are affected: every other save on this card never
     * reaches this branch, so a failing count cannot block ordinary editing.
     */
    if (!counted.ok) {
      /*
       * ⚠️ NOTHING SAVED, AND THE MESSAGE HAS TO SAY SO. This used to read
       * "what it is for and its reference prefix were left alone", which
       * describes a partial save that does not exist — this is a `return`, so
       * the name, the description, the routing and everything else typed on
       * the card went nowhere either. Being told two fields were skipped is
       * being told the other eight landed.
       */
      return {
        ok: false,
        error:
          "Could not check whether this form already has submissions, so nothing was " +
          `saved. Your changes are still on screen — try again. ${counted.message}`,
      };
    }

    const submissions = counted.total;

    if (submissions > 0 && purposeChanged) {
      return {
        ok: false,
        error: "What a form is for cannot change once it has submissions.",
        fieldErrors: {
          purpose: [
            `Locked as ${FORM_PURPOSE_LABELS[form.purpose].label.toLowerCase()} — ` +
              `${submissions} submission${submissions === 1 ? "" : "s"} already went through it.`,
          ],
        },
      };
    }

    if (submissions > 0 && anonymityChanged) {
      return {
        ok: false,
        error: "Whether a form is anonymous cannot change once it has answers.",
        fieldErrors: {
          is_anonymous: [
            `Locked as ${form.is_anonymous ? "anonymous" : "named"} — ` +
              `${submissions} ${submissions === 1 ? "answer" : "answers"} already came in under ` +
              "that promise. Build a new form instead.",
          ],
        },
      };
    }

    if (submissions > 0 && prefixChanged) {
      return {
        ok: false,
        error: "The reference prefix cannot change once requests are using it.",
        fieldErrors: {
          reference_prefix: [
            `Locked at ${form.reference_prefix} — ${submissions} request${submissions === 1 ? "" : "s"} already quote it.`,
          ],
        },
      };
    }
  }

  /*
   * ⚠️ `audience` IS LIFTED OFF, BECAUSE IT IS NOT A COLUMN. It is a flag plus a
   * set of rows in another table, and it is written below by
   * `vizserve_pms_set_form_audience` in one transaction of its own. Destructured
   * rather than deleted so the type system goes on checking that nothing else
   * strays into `.update()` — which is how this was caught in the first place.
   */
  const { audience, ...formRow } = parsed.data;

  const { error } = await supabase
    .from("vizserve_pms_forms")
    // `is_public` derived, exactly as on the insert — see the note there.
    .update({ ...formRow, is_public: isPublicForPurpose(parsed.data.purpose) })
    .eq("id", formId);

  if (error) {
    if (isUniqueViolation(error)) {
      const clash = uniqueFieldError(error);
      return { ok: false, error: clash.error, fieldErrors: { [clash.field]: [clash.message] } };
    }
    return { ok: false, error: error.message };
  }

  /*
   * ABSENT MEANS LEAVE IT ALONE — see the note on the schema key. A client form
   * never sends one, and a staff form that sends one has already been checked
   * against its purpose above.
   */
  if (audience) {
    const audienceFailure = await writeFormAudience(supabase, formId, audience);

    /*
     * ⚠️ REVALIDATED EVEN ON THE FAILURE PATH, because the settings above DID
     * land. Returning without it would leave the screen showing the old name
     * beside an error about the audience, and the person would reasonably
     * conclude nothing saved and do it all again.
     */
    if (audienceFailure) {
      revalidatePath("/forms");
      revalidatePath(`/forms/${formId}`);
      return audienceFailure;
    }
  }

  revalidatePath("/forms");
  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * P7-66 Phase 2 — THE ONE WRITE THE BUILDER MAKES.
 *
 * `saveField`, `setFieldActive` and `moveField` are gone, and so is
 * ./form-schema-sync.ts, which existed only to keep the blob in step behind
 * them. All four are replaced by this: the builder edits a schema in the
 * browser and posts the whole document, and
 * `vizserve_pms_save_form_schema` stores it AND projects it back into
 * `vizserve_pms_form_fields` in ONE function call, therefore one transaction.
 *
 * That transaction is the point. The three actions were three unsynchronised
 * round trips with no transaction around them, which is why `moveField` could
 * leave a half-applied renumbering and why the dual-write could leave a blob
 * that never landed. Here a failure — including the R5 trigger refusing a
 * rename or a delete — rolls the whole save back, blob included, and the form
 * is exactly as it was.
 *
 * ⚠️ THE SCHEMA IS RE-VALIDATED HERE, not trusted. The builder store runs the
 * same rules before it calls, but this is a server action: the front end will be
 * bypassed. `parseFormSchema` IS `formBuilder.validateSchema` (lib/form-builder/
 * schema.ts), so there is one rule set rather than a server copy free to drift.
 *
 * ⚠️ AND THE NORMALISED SCHEMA IS WHAT IS SENT. `parseFormSchema` returns the
 * schema with every attribute validator's output written back — `options ?? []`,
 * `required ?? true` — so what lands in the column is the document the next
 * `parseFormSchema` will read back unchanged. Posting the raw one would store a
 * blob whose round trip is only usually the identity.
 *
 * Authorization is `assertCanEditForm` here and RLS underneath: the function is
 * SECURITY INVOKER precisely so `forms updatable in scope` and `form fields
 * follow their form` are the enforcement, exactly as they were when these
 * actions wrote the rows directly.
 */
/**
 * P7-66 — RENAMING THE FORM FROM THE BUILDER'S TOP BAR.
 *
 * ⚠️ A SECOND WRITE PATH TO ONE COLUMN, AND THE NARROWNESS IS THE WHOLE POINT.
 * `updateFormSettings` can also set the name — and it demands a COMPLETE
 * `formSettingsSchema` payload while it does, because that schema defaults
 * nothing and every key it parses is handed straight to `.update()`. Sending
 * eleven other settings back to change one word is how a rename ends up
 * republishing a draft or blanking a description that was edited in another
 * tab. This writes `name` and nothing else.
 *
 * The trade is stated plainly: the field is now settable from two places, and
 * both of them must keep agreeing about what a legal name is. They do, by
 * construction — this schema IS `formSettingsSchema.shape.name`, so there is one
 * rule and no copy of it. A second constraint would drift; a reference cannot.
 *
 * ⚠️ NO SLUG DERIVATION. `slugFromName` runs on CREATE only. A form that has
 * been renamed keeps the URL it was published under, because that URL is in a
 * client's inbox and in whatever email pointed staff at it — see the note on
 * `slugFromName`. Renaming is a display change, deliberately.
 *
 * ⚠️ RENAMING A LIVE FORM IS ALLOWED. The name is what a client reads above the
 * questions, so it can be wrong and it should be fixable without unpublishing.
 * There is no lock to add here: unlike the prefix, the purpose and the anonymity
 * flag, nothing downstream is keyed to the name, and no submission is orphaned
 * by it changing.
 */
export async function renameForm(formId: string, name: unknown): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);

  const parsed = formSettingsSchema.shape.name.safeParse(name);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Give the form a name." };
  }

  const { error } = await supabase
    .from("vizserve_pms_forms")
    .update({ name: parsed.data })
    .eq("id", formId);

  // `name` carries no unique index — two departments may legitimately both run a
  // "Feedback" form; the slug is the identifier and it is untouched here. So
  // there is no `isUniqueViolation` branch: any error is a real one.
  if (error) return { ok: false, error: error.message };

  revalidatePath("/forms");
  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * P7-66 — DOWNLOAD A STAFF FORM'S ANSWERS.
 *
 * ⚠️ IT RUNS AS THE CALLER, WITH NO SERVICE-ROLE CLIENT ANYWHERE. `form
 * responses readable by the owning department` is what decides which rows come
 * back, exactly as it does for the screen — so an export can never contain a row
 * the person could not already read on the page they clicked from. An admin
 * client here would be a quiet privilege escalation dressed as a convenience,
 * and it would be invisible: the file would simply have more rows in it.
 *
 * ⚠️ `assertCanEditForm` AS WELL, and it is not redundant with the policy above.
 * The policy governs the RESPONSES; this governs the FORM — a lead of another
 * department can legitimately READ a published internal form (the phase-4b
 * company-wide policy), and administering it is a different question with no
 * row-level answer. Same reasoning as `administersForm` on the builder page.
 *
 * ⚠️ NOT PAGED, AND DELIBERATELY NOT CAPPED THE WAY THE SCREEN IS. The screen
 * caps at a thousand because it renders every row; a file is the one place where
 * "all of them" is the whole point, and a truncated export is a spreadsheet
 * somebody draws a conclusion from. If this ever needs a limit it needs a
 * streaming response, not a silent slice.
 *
 * The CSV is returned as a string for the browser to save. The DTR export does
 * the same — `downloadBase64` is for binaries, and a base64 round trip on text
 * buys nothing but a chance to get the encoding wrong.
 */
/** One page of the export read. Under any plausible project `max-rows`. */
const EXPORT_PAGE = 500;

/**
 * The point at which a CSV built in memory stops being the right answer.
 *
 * Not a silent truncation: past this the action REFUSES and says why, because a
 * shortened spreadsheet is indistinguishable from a complete one.
 */
const EXPORT_MAX_ROWS = 20_000;

export async function exportFormResponses(
  formId: string,
): Promise<ActionResult<{ filename: string; csv: string }>> {
  const { supabase } = await assertCanEditForm(formId);

  const { data: form, error: formError } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, purpose, is_anonymous, schema")
    .eq("id", formId)
    .maybeSingle();

  if (formError) return { ok: false, error: formError.message };
  if (!form) return { ok: false, error: "That form does not exist, or is outside your scope." };

  /*
   * ⚠️ INTERNAL FORMS ONLY. A client form's submissions are
   * `vizserve_pms_requests`, and this reads `vizserve_pms_form_responses` — so
   * on a client form it would cheerfully produce a file with a header row and
   * nothing under it, which reads as "no submissions" rather than "wrong table".
   */
  if (form.purpose !== "INTERNAL") {
    return {
      ok: false,
      error: "A client form's submissions are requests. Export them from the request queue.",
    };
  }

  /*
   * ⚠️ THE SCHEMA IS RECONCILED AGAINST THE ROWS, exactly as the builder page
   * does it, and for the same reason: the stored blob can be stale, and a stale
   * blob here means a column missing from the file. `reconcileFormSchema` lets
   * the ROWS win. See the note on the builder page's read.
   */
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("vizserve_pms_form_fields")
    .select(
      "id, label, field_key, field_type, help_text, options, is_required, is_active, sort_order, created_at",
    )
    .eq("form_id", formId)
    .order("sort_order");

  if (fieldsError) return { ok: false, error: fieldsError.message };

  const fields: FormFieldRow[] = [];

  for (const row of fieldRows ?? []) {
    const options = optionsFromRow(row.options);
    // Refused rather than narrowed, as the builder does: a filtered option list
    // is a silently different form.
    if (options === null) {
      return { ok: false, error: `The field "${row.field_key}" could not be read.` };
    }

    fields.push({
      id: row.id,
      label: row.label,
      field_key: row.field_key,
      field_type: row.field_type as FieldType,
      help_text: row.help_text,
      options,
      is_required: row.is_required,
      is_active: row.is_active,
      sort_order: row.sort_order,
      created_at: row.created_at,
    });
  }

  const { schema } = reconcileFormSchema(form.schema, fields);

  /*
   * ⚠️⚠️ PAGED WITH `.range()`, BECAUSE "NO LIMIT" IS NOT THE SAME AS "ALL OF
   * THEM".
   *
   * A query with no `.limit()` is still capped by the PROJECT's `max-rows`
   * setting — 1000 by default on Supabase — and PostgREST truncates silently:
   * no error, no flag, just fewer rows. So the sentence three paragraphs up
   * ("a truncated export is a spreadsheet somebody draws a conclusion from")
   * would have been exactly wrong about this function, in the one place where
   * being wrong is invisible.
   *
   * So it reads pages until a short one comes back. `PAGE` is under any
   * plausible `max-rows`, and the loop is bounded — a form with more answers
   * than `EXPORT_MAX_ROWS` fails LOUDLY rather than handing over a partial file,
   * because at that scale the honest answer is a streaming export and not a
   * quiet slice.
   */
  const rows: { submitted_by: string | null; field_values: unknown; submitted_at: string }[] = [];

  for (let from = 0; from < EXPORT_MAX_ROWS; from += EXPORT_PAGE) {
    const { data: page, error: responsesError } = await supabase
      .from("vizserve_pms_form_responses")
      .select("submitted_by, field_values, submitted_at")
      .eq("form_id", formId)
      .order("submitted_at", { ascending: false })
      .range(from, from + EXPORT_PAGE - 1);

    if (responsesError) return { ok: false, error: responsesError.message };

    rows.push(...(page ?? []));

    // A short page is the end. An exactly-full one might not be, so it goes
    // round again — the empty page that follows costs one round trip and is the
    // only way to be sure.
    if ((page?.length ?? 0) < EXPORT_PAGE) break;

    if (rows.length >= EXPORT_MAX_ROWS) {
      return {
        ok: false,
        error:
          `This form has more than ${EXPORT_MAX_ROWS} answers, which is more than this export ` +
          "can produce in one file. Tell whoever maintains the app — it needs a streaming " +
          "export rather than a shortened one.",
      };
    }
  }

  /*
   * ⚠️ THE NAME LOOKUP IS NOT MADE AT ALL ON AN ANONYMOUS FORM. There is no id
   * to look up — every `submitted_by` is null by the INSERT policy — and a
   * lookup running over a form that promised not to record a name is the kind of
   * line that later grows a fallback nobody meant to write.
   */
  const submitterIds = form.is_anonymous
    ? []
    : [
        ...new Set(
          rows.map((row) => row.submitted_by).filter((id): id is string => id !== null),
        ),
      ];

  const names: Record<string, string> = {};

  /*
   * Chunked for the reason the screen's lookup is: `.in()` becomes a query
   * string on a GET, and this read is not capped at all.
   *
   * ⚠️ A FAILED CHUNK IS LOGGED, NOT SWALLOWED. It writes "Outside your
   * department" into a hundred rows of a spreadsheet — a claim about PERMISSIONS
   * that is both false and unfalsifiable from the file. It is deliberately not
   * fatal, for the same reason it is not on the screen: withholding the answers
   * because a name did not arrive is the more damaging of the two failures. But
   * an untraceable one is worse than either.
   */
  for (let at = 0; at < submitterIds.length; at += 100) {
    const { data: users, error: namesError } = await supabase
      .from("vizserve_pms_users")
      .select("id, full_name")
      .in("id", submitterIds.slice(at, at + 100));

    if (namesError) {
      console.error("[P7-66] a name lookup failed while exporting answers", {
        formId,
        from: at,
        message: namesError.message,
      });
    }

    for (const user of users ?? []) names[user.id] = user.full_name;
  }

  return {
    ok: true,
    data: {
      filename: responsesCsvFilename(form.name, todayInAppZone()),
      csv: responsesToCsv(schema, rows, {
        isAnonymous: form.is_anonymous,
        names,
        formatTimestamp: formatDateTime,
      }),
    },
  };
}

export async function saveSchema(formId: string, input: unknown): Promise<ActionResult> {
  const { supabase } = await assertCanEditForm(formId);

  let schema;

  try {
    schema = await parseFormSchema(input);
  } catch (cause) {
    if (!(cause instanceof FormSchemaError)) throw cause;

    // The reason CODE, never the payload: it can carry a raw thrown value, and
    // this is a staff screen but the same helper shape guards the public one.
    console.error("[P7-66] refused a form schema", { formId, reason: cause.reason.code });
    return { ok: false, error: schemaRejectionMessage(cause.reason) };
  }

  const { error } = await supabase.rpc("vizserve_pms_save_form_schema", {
    p_form_id: formId,
    // The brand is a phantom type; the value is plain records, strings, booleans
    // and arrays, so it serialises to jsonb unchanged.
    p_schema: schema as unknown as Json,
  });

  // Surfaced verbatim. The messages that matter here are Postgres's own R5
  // refusals — `field_key "x" is immutable once the form has submissions` and
  // `Field "x" has data on existing requests and cannot be deleted` — which say
  // exactly what happened and what to do instead. Replacing them with a house
  // sentence would lose the field name.
  if (error) return { ok: false, error: error.message };

  revalidatePath("/forms");
  revalidatePath(`/forms/${formId}`);
  return { ok: true, data: undefined };
}

/**
 * A library rejection → one sentence for whoever is building the form.
 *
 * `InvalidSchema` is the branch that matters: it wraps whatever
 * `formBuilder.validateSchema` threw, and those messages were written to be read
 * ("Two fields share the key …", "Priority needs at least one option"). Every
 * other code is a malformed document rather than a rule somebody broke — the
 * builder store cannot produce one — so it gets a general sentence instead of a
 * code nobody can act on.
 */
function schemaRejectionMessage(reason: FormSchemaRejection): string {
  if (reason.code === "InvalidSchema" && reason.payload.schemaError instanceof Error) {
    return reason.payload.schemaError.message;
  }

  return (
    "This form could not be saved. Check that every field has a label and a key, " +
    "and that each choice field has at least one option."
  );
}

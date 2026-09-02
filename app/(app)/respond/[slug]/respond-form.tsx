"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { UploadFn } from "@/components/file-field";
import {
  FieldRuntimeProvider,
  InterpreterFields,
  initialEntityValues,
  useFormInterpreterStore,
} from "@/lib/form-builder/components";
import type { ParsedFormSchema } from "@/lib/form-builder/schema";
import { routeFieldErrors, toFieldValues } from "@/lib/form-builder/values";

import { submitFormResponse } from "../actions";

/**
 * P7-66 Phase 4b — the fill page's form.
 *
 * ⚠️ `mode: "interpreter"`, NEVER `"builder"`. The component map in
 * lib/form-builder/components.tsx is shared between the builder preview and
 * every live form, and it renders EVERY CONTROL DISABLED in `builder` mode —
 * which is exactly right for a preview and would be a form nobody can type into
 * here. `FieldRuntime` defaults to `builder` when the provider is missing, on
 * the argument that an inert form is a visible bug and a form wired to nothing
 * is not, so this provider is not optional.
 *
 * ⚠️ ONE STATE OWNER, unlike the public form. `/request/[slug]` has five fixed
 * fields in `react-hook-form` beside the interpreter store, and three named
 * seams where the two meet. A staff response has no fixed fields at all — no
 * name, no email, no title, no target date, because the session already says
 * who this is — so the interpreter store owns everything and there is no merge,
 * no `routeFieldErrors` fallback to a core input, and no second validity check
 * to keep in step. That simplicity is the reason the page is short.
 */

/**
 * ⚠️ A `file` FIELD CANNOT BE ANSWERED HERE YET, AND IT SAYS SO.
 *
 * The attachment machinery is request-shaped end to end: `uploadPublicAttachment`
 * writes `vizserve_pms_pending_attachments` scoped to a form, and those rows are
 * CLAIMED by `vizserve_pms_submit_request` when it mints a request. A staff
 * response mints no request, so an upload made here would leave a pending row
 * nothing ever claims and an answer pointing at a receipt with no owner.
 *
 * So the picker refuses, in a sentence that is true. It could have been left as
 * `previewUpload`'s "This is a preview." — that is a lie on a live form, and a
 * person who is told they are looking at a preview will keep trying.
 *
 * An OPTIONAL file question is survivable: the form renders, every other field
 * works, and the note above it says where the file should go instead.
 *
 * ⚠️ A REQUIRED ONE IS NOT, AND THIS USED TO BE A TRAP. `fileEntity` demands
 * at least one attachment reference, the picker above can never produce one,
 * so `validateEntitiesValues` refuses forever — the person fills in nine
 * questions, presses Send answer, and is told to attach a file by a control
 * that refuses to attach files. A note reading "send it to whoever asked for
 * it instead" made that worse by implying the rest could still go through.
 *
 * So the form is not rendered at all in that case. Saying "you cannot answer
 * this yet" before somebody types is the only honest option; the alternative is
 * a form that takes ten minutes and cannot be sent.
 */
const unsupportedUpload: UploadFn = async () => ({
  ok: false,
  error: "Files cannot be attached to an internal form yet. Send it to whoever asked for it instead.",
});

export function RespondForm({
  formId,
  formSlug,
  formName,
  isAnonymous,
  schema,
}: {
  formId: string;
  /**
   * ⚠️ PASSED, NOT READ OFF `window.location`. The action re-reads the form from
   * this slug and re-checks that it is a published internal form, so it is
   * part of the payload rather than a display detail — and a value derived from
   * the URL bar would go wrong on a trailing slash, a query string, or the day
   * this component is reused anywhere else.
   */
  formSlug: string;
  formName: string;
  /**
   * P7-66 — ⚠️ WHAT THE PAGE ABOVE THIS FORM PROMISED, AND THE ONLY REASON THIS
   * COMPONENT KNOWS ABOUT ANONYMITY AT ALL.
   *
   * It decides nothing. `submitFormResponse` reads the flag off the form's own
   * row and the INSERT policy re-checks it — this value is echoed back in the
   * payload so the action can REFUSE if the form stopped agreeing with the
   * sentence the person read. The flag locks on the first answer, so the window
   * is "a form with no answers yet, open in somebody's browser, whose owner
   * flips the switch" — small, and the promise is the whole feature.
   *
   * It also picks the confirmation sentence below, which used to tell everybody
   * their answer was "saved against your name".
   */
  isAnonymous: boolean;
  /**
   * ⚠️ PARSED ON THE SERVER, and the brand travels because it is a phantom
   * type — `ParsedFormSchema` adds no runtime property, so what crosses the RSC
   * boundary is the plain `{ entities, root }` document. Re-parsing here would
   * mean running `validateSchema` in the browser on every load to learn
   * something the server already established.
   */
  schema: ParsedFormSchema;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /*
   * ⚠️ BOTH MEMOISED ON `[schema]`, AND IT MATTERS. `useInterpreterStore`
   * memoises the store on `[builder, schema]`; a schema rebuilt on every render
   * rebuilds the store on every render and every answer typed into it is
   * discarded. `schema` is a prop from an RSC and is referentially stable
   * between renders of this component, so this holds.
   */
  const initialValues = useMemo(() => initialEntityValues(schema), [schema]);
  const interpreterStore = useFormInterpreterStore(schema, initialValues);

  const runtime = useMemo(
    () => ({ mode: "interpreter" as const, formId, upload: unsupportedUpload }),
    [formId],
  );

  /*
   * The file questions this form actually draws, in root order. Archived
   * entities render nothing (the library skips an unprocessable entity), so
   * they cannot raise a warning — or block a submission — over a control
   * nobody can see.
   *
   * {W} REQUIRED AND OPTIONAL ARE DIFFERENT OUTCOMES, not different wording.
   * An optional file question is a note; a required one means this form cannot
   * be submitted at all, and it is named so the person has something concrete
   * to report.
   */
  const fileFields = useMemo(
    () =>
      schema.root.flatMap((entityId) => {
        const entity = Object.hasOwn(schema.entities, entityId)
          ? schema.entities[entityId]
          : undefined;

        return entity?.type === "file" && entity.attributes.archived !== true ? [entity] : [];
      }),
    [schema],
  );

  const blockingFileField = fileFields.find((entity) => entity.attributes.required);
  const hasFileField = fileFields.length > 0;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setPending(true);

    try {
      // Resolves either way and writes its own errors into the store, so a
      // refusal is already sitting against the fields it belongs to.
      const validated = await interpreterStore.validateEntitiesValues();

      if (!validated.success) {
        setFormError("Please correct the highlighted answers.");
        return;
      }

      // §1: entity ids stay inside lib/form-builder. What leaves this component
      // is keyed by `field_key`, which is what the column stores.
      const result = await submitFormResponse({
        slug: formSlug,
        field_values: toFieldValues(schema, validated.data),
        // Echoed, not chosen. See the prop's note: the action compares this and
        // refuses on a mismatch, and never writes from it.
        promised_anonymous: isAnonymous,
      });

      if (result.ok) {
        setSubmitted(true);
        return;
      }

      /*
       * Server field errors win — the server re-derives the required list from
       * the stored schema, so it can legitimately refuse something the browser
       * accepted (an archived field, a schema saved while this page was open).
       *
       * `isCoreField` is constantly false: this page has no fixed inputs, so a
       * key nothing on the form claims has nowhere to go but the form-level
       * message. Dropping it would refuse the person with nothing highlighted.
       */
      if (result.field_errors) {
        const routed = routeFieldErrors(schema, result.field_errors, () => false);

        for (const { entityId, message } of routed.entities) {
          interpreterStore.setEntityError(entityId, message);
        }

        setFormError(routed.unplaced ?? result.error);
        return;
      }

      setFormError(result.error);
    } catch (cause) {
      /*
       * ⚠️ A THROW MUST NOT BE SILENCE. `try/finally` with no `catch` stopped
       * the spinner and left the page exactly as it was: no error, no
       * confirmation, nothing said at all. A server action does not only return
       * `{ ok: false }` — it can REJECT, on a transport failure, a redeploy
       * mid-request, or anything uncaught inside the action itself.
       *
       * ⚠️ AND IT MUST NOT CLAIM NOTHING WAS SAVED, WHICH IS THE TEMPTING
       * SENTENCE AND IS NOT KNOWABLE HERE. A rejected promise covers both "the
       * request never arrived" and "the row was written and the reply was lost
       * on the way back" — the browser cannot tell those apart. It matters
       * because `vizserve_pms_form_responses` is APPEND-ONLY: there is no
       * update and no delete policy, so a second attempt that turns out to be a
       * duplicate stands as a second answer forever, and the author cannot even
       * read their own row back to check (the SELECT policy is admin-or-lead).
       *
       * So the message says what is true — we do not know — names the one
       * consequence of trying again, and leaves the choice with the person.
       * `/respond`'s success panel already tells them a duplicate is visible
       * rather than silently merged, so this is the same promise kept under
       * failure.
       *
       * The detail is logged rather than shown: it is a stack or a network
       * error, which tells the person nothing and the console everything.
       */
      console.error("[P7-66] submitting a form response threw —", cause);
      setFormError(
        "Your answer may not have been sent — the connection dropped before we heard back. " +
          "Sending it again is safe, but if both arrive the team will see two answers.",
      );
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center grade-surface shadow-raised-lg">
        <div
          className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-success-subtle text-success"
          aria-hidden
        >
          <CheckCircle2 className="size-6" />
        </div>
        <h2 className="text-lg font-semibold tracking-[-0.014em]">Answer recorded</h2>
        {/* The promise, kept in the past tense. Telling somebody who answered an
            anonymous survey that it was "saved against your name" is the exact
            sentence the setting exists to make untrue. */}
        <p className="mt-2 text-sm text-muted-foreground">
          {isAnonymous
            ? `Thank you — your answer to ${formName} has been saved without your name.`
            : `Thank you — your answer to ${formName} has been saved against your name.`}
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          It cannot be edited or withdrawn. If you need to change something, fill the form in
          again and both answers will be visible.
        </p>
      </div>
    );
  }

  /*
   * ⚠️ REFUSED BEFORE IT IS FILLED IN, not after. See the note on
   * `unsupportedUpload`: a required file question cannot be satisfied on this
   * page by any sequence of actions, so rendering the form would be an
   * invitation to waste ten minutes.
   *
   * It names the question, because "a question on this form" is not something
   * anybody can report usefully, and it points at the person who can fix it —
   * the fix is the form's owner making that question optional or removing it,
   * neither of which the person reading this can do.
   */
  if (blockingFileField) {
    return (
      <div className="rounded-lg border border-warning-border bg-warning-subtle p-6 grade-surface shadow-raised-lg">
        <div className="flex gap-3">
          <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold text-warning">
              This form cannot be answered yet
            </h2>
            <p className="text-sm leading-relaxed text-warning">
              {formName} requires a file for
              {" “"}
              {blockingFileField.attributes.label}
              {"”"}, and attachments are not collected on internal forms yet — so there is no
              way to send it.
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Nothing you type here could be saved, so the questions are not shown. Tell whoever
              asked you to fill this in: the form needs that question made optional or removed
              before anybody can answer.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <FieldRuntimeProvider runtime={runtime}>
      <form
        onSubmit={onSubmit}
        noValidate
        className="space-y-6 rounded-lg border bg-card p-6 grade-surface shadow-raised-lg"
      >
        {hasFileField ? (
          /*
           * Only ever reached for an OPTIONAL file question — a required one
           * returned above — so the sentence can honestly say the rest of the
           * form still goes through.
           *
           * `role="note"` rather than `alert`: this is static page content that
           * is true before anybody does anything, and announcing it as an alert
           * on every render interrupts a screen reader mid-task.
           */
          <p
            role="note"
            className="flex gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs leading-relaxed text-warning"
          >
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              This form asks for a file. Attachments are not collected on internal forms yet — send
              the file to whoever asked for it instead. The rest of your answers still go
              through.
            </span>
          </p>
        ) : null}

        <div className="space-y-4">
          <InterpreterFields interpreterStore={interpreterStore} />
        </div>

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end border-t pt-4">
          <Button type="submit" loading={pending}>
            Send answer
          </Button>
        </div>
      </form>
    </FieldRuntimeProvider>
  );
}

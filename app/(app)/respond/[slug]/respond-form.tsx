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
 * The form still renders and every other field still works. If the file field
 * is REQUIRED the form cannot be submitted, which is correct: storing a
 * response with a missing required answer would be worse than refusing it. The
 * banner above the form is what stops that being a mystery.
 */
const unsupportedUpload: UploadFn = async () => ({
  ok: false,
  error: "Files cannot be attached to a staff form yet. Send it to whoever asked for it instead.",
});

export function RespondForm({
  formId,
  formSlug,
  formName,
  schema,
}: {
  formId: string;
  /**
   * ⚠️ PASSED, NOT READ OFF `window.location`. The action re-reads the form from
   * this slug and re-checks that it is a published engagement form, so it is
   * part of the payload rather than a display detail — and a value derived from
   * the URL bar would go wrong on a trailing slash, a query string, or the day
   * this component is reused anywhere else.
   */
  formSlug: string;
  formName: string;
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

  // Root order, so the banner reflects the form as it is drawn. Archived
  // entities render nothing (the library skips an unprocessable entity), so
  // they cannot raise a warning about a control nobody can see.
  const hasFileField = useMemo(
    () =>
      schema.root.some((entityId) => {
        const entity = Object.hasOwn(schema.entities, entityId)
          ? schema.entities[entityId]
          : undefined;
        return entity?.type === "file" && entity.attributes.archived !== true;
      }),
    [schema],
  );

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
        <p className="mt-2 text-sm text-muted-foreground">
          Thank you — your answer to {formName} has been saved against your name.
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          It cannot be edited or withdrawn. If you need to change something, fill the form in
          again and both answers will be visible.
        </p>
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
              This form asks for a file. Attachments are not collected on staff forms yet — send
              the file to whoever asked for it instead.
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

"use client";

import { useMemo, useState } from "react";
import { useForm, Controller, type Path, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileField } from "@/components/file-field";
import {
  FieldRuntimeProvider,
  FormPageNav,
  InterpreterFields,
  useFormPages,
  validateInterpreterPage,
  initialEntityValues,
  useFormInterpreterStore,
} from "@/lib/form-builder/components";
import { schemaFromPublicFields } from "@/lib/form-builder/schema";
import {
  mergeSubmissionPayload,
  routeFieldErrors,
  type FieldValues,
} from "@/lib/form-builder/values";
import { requestCoreSchema, type AttachmentRef, type PublicForm } from "@/lib/schemas/forms";

import { submitPublicRequest, uploadPublicAttachment } from "./actions";

/**
 * The value shape is stable even though the form is not: the five fixed fields
 * every client request carries (docs/01-updated-workflow.md §2.2), plus
 * `requester_org`. Typing it concretely keeps `register` and `setError` honest,
 * which `as never` everywhere does not.
 *
 * ⚠️ `field_values` IS GONE FROM HERE — see the note on the two state owners
 * below. The dynamic answers are the interpreter store's, not
 * `react-hook-form`'s.
 */
type SubmissionFormValues = {
  requester_name: string;
  requester_email: string;
  requester_org: string;
  title: string;
  description: string;
  target_date: string;
};

/**
 * The five fixed fields, by name.
 *
 * Used to route a SERVER field error to the right owner: a key in this list is
 * `react-hook-form`'s, anything else is a `field_key` and belongs to the
 * interpreter store.
 */
const CORE_FIELD_NAMES = [
  "requester_name",
  "requester_email",
  "requester_org",
  "title",
  "description",
  "target_date",
] as const;

function isCoreField(key: string): key is (typeof CORE_FIELD_NAMES)[number] {
  return (CORE_FIELD_NAMES as ReadonlyArray<string>).includes(key);
}

/**
 * The receipts a `file` field is holding, read defensively.
 *
 * `Object.hasOwn` and no bare bracket look-up, for the reason values.ts states
 * at length: `FIELD_KEY_PATTERN` allows `constructor`, and `values.constructor`
 * on a plain object answers with a function rather than `undefined` — which
 * would put a function into the attachment list rather than nothing.
 */
function attachmentsFor(values: FieldValues, fieldKey: string): AttachmentRef[] {
  if (!Object.hasOwn(values, fieldKey)) return [];

  const value = values[fieldKey];
  return Array.isArray(value) ? (value as AttachmentRef[]) : [];
}

export function PublicFormRenderer({
  form,
}: {
  form: PublicForm;
  /**
   * P7-49. Read on the server from the `VITE_EMAILJS_*` keys and handed down,
   * because that prefix is Vite's and means nothing to Next — those values are
   * invisible to the browser otherwise. Null when EmailJS is not set up, which
   * is a normal state: the form still works, the client just gets no email.
   */
}) {
  const [submitted, setSubmitted] = useState<{ reference_no: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const rules = form.attachment_rules;
  const maxBytes = rules?.max_bytes;
  /*
   * ⚠️ NOTHING SERVER-SIDE COUNTS THE FILES. `max_files` is a browser-side
   * ceiling only: `uploadPendingAttachment` checks each file's bytes, its MIME
   * type and its magic number, and `vizserve_pms_submit_request` checks that a
   * form requiring an attachment got at least one — neither has an upper bound,
   * so a caller posting straight at the action can still exceed this. Threading
   * it fixes the configured form; it does not close the hole, and a comment
   * saying so is cheaper than a reader assuming otherwise.
   */
  const maxFiles = rules?.max_files;
  // A filter on the file dialog, not a control. The server checks the actual
  // bytes; this only spares the client picking something that cannot work.
  const accept = rules?.allowed_mime_types.length ? rules.allowed_mime_types.join(",") : undefined;

  /**
   * THE FORM-LEVEL ATTACHMENT — the fix for an unsubmittable form.
   *
   * `requires_attachment` is a property of the FORM, and
   * `vizserve_pms_submit_request` rejects a submission with zero attachments
   * when it is set. But the renderer only ever drew a file picker for a field of
   * type `file`. Turn the toggle on without adding such a field — which the
   * settings screen happily allows — and the client gets a form that the
   * database refuses, with nothing on the page to attach anything to.
   *
   * So: when a file is required and no field collects one, the form grows its
   * own attachment slot.
   */
  const hasFileField = form.fields.some((field) => field.field_type === "file");
  const needsOwnAttachment = form.requires_attachment && !hasFileField;


  const [formAttachments, setFormAttachments] = useState<AttachmentRef[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  /*
   * ⚠️ THE FORM HAS TWO STATE OWNERS, AND THIS IS THE SEAM BETWEEN THEM.
   *
   * `react-hook-form` owns the five fixed fields. The interpreter store owns
   * every field the form was built with — it keeps its own values AND its own
   * errors, keyed by entity id, and there is no way to make it defer to RHF
   * short of reimplementing it.
   *
   * So neither is made the master. Instead the split is made TOTAL and the two
   * are joined at exactly three points, each named where it happens:
   *
   *   1. SUBMIT BLOCKS ON BOTH. `handleSubmit`'s valid path runs
   *      `validateEntitiesValues()` before it posts anything, and its INVALID
   *      path runs it too — otherwise a blank name would hide every dynamic
   *      error until the name was fixed, and the client would correct the form
   *      one half at a time.
   *   2. THE PAYLOAD IS MERGED ONCE, in `submit`: RHF's parsed values spread
   *      flat, the interpreter's translated back to `field_key`s under
   *      `field_values`. That is the shape `vizserve_pms_submit_request` has
   *      always read (`p_payload -> 'field_values' -> field_key`), so nothing
   *      downstream changes.
   *   3. SERVER ERRORS ARE ROUTED BY NAME. `field_errors` is keyed by
   *      `field_key`, which is exactly what the §1 translation speaks, so
   *      `routeFieldErrors` resolves each one against the form's own fields
   *      first and falls back to a core name only when no field claims that key
   *      — a per-form field may perfectly well be named `title`, and the flat
   *      `field_errors` bag has no nesting to keep the two apart. A message that
   *      matches neither is shown as the form-level error rather than dropped —
   *      `attachments` is one, and it used to be set on a
   *      `field_values.attachments` path that renders nowhere.
   *
   * The one thing that does NOT need reshaping is the error KEY. Both halves
   * speak `field_key`, which is the whole point of §1.
   */
  const schema = useMemo(() => schemaFromPublicFields(form.fields), [form]);
  // Computed once, for the same reason the store is: `useInterpreterStore`
  // memoises on the schema, so `initialData` is the opening document and not a
  // controlled value.
  const initialValues = useMemo(() => initialEntityValues(schema), [schema]);
  const interpreterStore = useFormInterpreterStore(schema, initialValues);

  const runtime = useMemo(
    () => ({
      mode: "interpreter" as const,
      formId: form.id,
      upload: uploadPublicAttachment,
      accept,
      maxFiles,
      maxBytes,
    }),
    [form.id, accept, maxFiles, maxBytes],
  );

  const {
    register,
    control,
    handleSubmit,
    setError,
    // P7-66 Phase 7 — Continue validates page one's fixed fields. See `onContinue`.
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<SubmissionFormValues>({
    // The five fixed fields only. The per-form fields are validated by their own
    // entity `validate`, which is a verbatim port of the `buildFieldSchema`
    // branch that used to be extended onto this schema.
    resolver: zodResolver(requestCoreSchema) as unknown as Resolver<SubmissionFormValues>,
    defaultValues: {
      requester_name: "",
      requester_email: "",
      requester_org: "HFSE",
      title: "",
      description: "",
      target_date: "",
    },
  });

  /*
   * P7-66 Phase 7 — WHICH PAGE IS SHOWING.
   *
   * The same `paginateFields` split the internal form and the builder's preview
   * use, so a client walks the form in exactly the pages the builder drew. A
   * form with no page breaks is one page and `FormPageNav` renders no navigation
   * for it — the form is byte-for-byte what it was before this phase.
   */
  const pages = useFormPages(interpreterStore);
  const [page, setPage] = useState(0);

  function back() {
    setFormError(null);
    setPage((current) => Math.max(0, current - 1));
  }

  /*
   * ⚠️ CONTINUE VALIDATES BEFORE IT ADVANCES, AND ON PAGE ONE IT HAS TWO
   * HALVES TO VALIDATE.
   *
   * This form has two state owners — `react-hook-form` holds the five fixed
   * fields, the interpreter store holds everything the form was built with — and
   * page one carries both. So Continue asks both, and asks BOTH BEFORE
   * deciding: `&&` would short-circuit, leaving the built questions on page one
   * unmarked whenever a fixed field was also blank, and the client would be sent
   * round the same page twice. Same reasoning as the submit handler's second
   * argument below.
   *
   * Later pages have no fixed fields on them, so `trigger()` is not called —
   * running it would mark the name and email fields red on page three, where
   * nobody can see or fix them.
   */
  async function onContinue() {
    setFormError(null);

    const items = pages[page]?.items ?? [];

    const [fixedOk, builtOk] = await Promise.all([
      page === 0 ? trigger() : Promise.resolve(true),
      validateInterpreterPage(interpreterStore, items),
    ]);

    if (!fixedOk || !builtOk) {
      setFormError("Please correct the highlighted fields before continuing.");
      return;
    }

    setPage((current) => Math.min(pages.length - 1, current + 1));
  }

  async function submit(values: SubmissionFormValues) {
    setFormError(null);
    setAttachmentError(null);

    // Seam 1. Resolves either way and writes its own errors into the store, so a
    // refusal is already sitting against the fields it belongs to.
    const dynamic = await interpreterStore.validateEntitiesValues();

    if (!dynamic.success) {
      setFormError("Please correct the highlighted fields.");
      return;
    }

    /*
     * Seam 2. ONE call, and the attachment sweep below reads its output rather
     * than translating a second time: two calls to the same translation are two
     * places for the payload and the receipts to disagree about what was
     * answered.
     */
    const payload = mergeSubmissionPayload(values, schema, dynamic.data);
    const fieldValues = payload.field_values as FieldValues;

    // Files are already uploaded and live under their own field keys; the
    // submission carries the receipts. Flattened here rather than kept in
    // field_values, because the database stores files in request_attachments and
    // field_values holds answers.
    const attachments = [
      ...form.fields
        .filter((field) => field.field_type === "file")
        .flatMap((field) => attachmentsFor(fieldValues, field.field_key)),
      ...formAttachments,
    ];

    // Checked against the TOTAL, not against the form-level slot. A form can
    // require a file while its only file field is optional, and the database
    // counts attachments without caring which field they came from — so this
    // has to ask the same question the server will.
    if (form.requires_attachment && attachments.length === 0) {
      setAttachmentError("This request needs at least one file attached.");
      setFormError("Please attach the required file.");
      return;
    }

    const result = await submitPublicRequest({
      slug: form.slug,
      // The shape is unchanged: the fixed fields flat, the per-form answers
      // under `field_values`.
      payload,
      attachments,
      honeypot:
        (document.getElementById("company_website") as HTMLInputElement | null)?.value ?? "",
    });

    if (result.ok) {

      setSubmitted({ reference_no: result.reference_no });
      return;
    }

    if (result.error === "rate_limited") {
      setFormError("Too many submissions from here in the last hour. Please try again later.");
      return;
    }

    if (result.error === "form_not_found") {
      setFormError("This form is no longer accepting submissions.");
      return;
    }

    // Server-side field errors win. The database re-derives the required list,
    // so it can legitimately reject something the browser thought was fine.
    if (result.field_errors) {
      /*
       * Seam 3. Both halves are keyed by `field_key`, so the routing is a name
       * look-up rather than a reshaping — but WHICH look-up runs first is a
       * real decision, and it is made once, in `routeFieldErrors`, where it can
       * be tested. A per-form field claims its key ahead of the core input of
       * the same name; the core list is the fallback. See the note there.
       */
      const routed = routeFieldErrors(schema, result.field_errors, isCoreField);

      for (const { entityId, message } of routed.entities) {
        interpreterStore.setEntityError(entityId, message);
      }

      for (const { name, message } of routed.core) {
        setError(name as Path<SubmissionFormValues>, { type: "server", message });
      }

      setFormError(routed.unplaced ?? "Please correct the highlighted fields.");
      return;
    }

    setFormError("Something went wrong. Please try again.");
  }

  const onSubmit = handleSubmit(
    (values) => submit(values),
    /*
     * Seam 1's other half. `react-hook-form` refused the fixed fields and will
     * not call the handler, so the dynamic half is validated HERE — otherwise a
     * blank name would hide every per-form error until it was fixed, and the
     * client would be sent round the form twice.
     */
    async () => {
      await interpreterStore.validateEntitiesValues();
      setFormError("Please correct the highlighted fields.");
    },
  );

  if (submitted) {
    return (
      <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-8 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-success-subtle text-success">
          ✓
        </div>
        <h2 className="text-lg font-semibold">Request received</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your reference number is{" "}
          <span className="font-medium text-foreground">{submitted.reference_no}</span>. Quote it in
          any email about this request.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          A team leader will review it and confirm the delivery date with you.
        </p>
      </div>
    );
  }

  return (
    <FieldRuntimeProvider runtime={runtime}>
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        {/* Honeypot (P1-15). Hidden from people, not from bots. */}
        <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
          <label htmlFor="company_website">Company website</label>
          <input id="company_website" name="company_website" tabIndex={-1} autoComplete="off" />
        </div>

        {/*
          P7-66 Phase 7 — THE FIVE FIXED FIELDS ARE PAGE ONE.

          Every client request carries name, email, title, description and target
          date whatever the form was built with, so they cannot belong to a page
          break somebody added — they come before the first one. On a form with
          no page breaks this `hidden` is never true and the markup is what it
          always was.
        */}
        <div hidden={page !== 0} className="space-y-6">
          <fieldset className="space-y-4">
            <legend className="mb-3 w-full border-b pb-2 text-sm font-semibold">Your details</legend>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="requester_name">
                Your name
                <span className="ml-0.5 text-destructive" aria-label="required">
                  *
                </span>
              </Label>
              <Input id="requester_name" {...register("requester_name")} />
              {errors.requester_name ? (
                <p className="text-sm text-destructive">{String(errors.requester_name.message)}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="requester_email">
                Email
                <span className="ml-0.5 text-destructive" aria-label="required">
                  *
                </span>
              </Label>
              <Input id="requester_email" type="email" {...register("requester_email")} />
              <p className="text-xs text-muted-foreground">
                We send the completed work here for your approval.
              </p>
              {errors.requester_email ? (
                <p className="text-sm text-destructive">{String(errors.requester_email.message)}</p>
              ) : null}
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-3 w-full border-b pb-2 text-sm font-semibold">Your request</legend>

          <div className="space-y-2">
            <Label htmlFor="title">
              Title
              <span className="ml-0.5 text-destructive" aria-label="required">
                *
              </span>
            </Label>
            <Input id="title" {...register("title")} />
            {errors.title ? (
              <p className="text-sm text-destructive">{String(errors.title.message)}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">
              Description
              <span className="ml-0.5 text-destructive" aria-label="required">
                *
              </span>
            </Label>
            <Textarea id="description" rows={4} {...register("description")} />
            {errors.description ? (
              <p className="text-sm text-destructive">{String(errors.description.message)}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="target_date">
              Target date
              <span className="ml-0.5 text-destructive" aria-label="required">
                *
              </span>
            </Label>
            {/*
              Through a Controller rather than `register`, because DatePicker is
              controlled and has no DOM event to hook a ref onto.

              ⚠️ CLIENT-FACING (§4.6): this is one of two screens somebody outside
              the company ever sees, and the browser's native picker was the last
              thing here that did not carry our tokens or a dark mode. The target
              date is also the field a client is most likely to get wrong — a real
              calendar showing them the day of the week is worth more here than
              anywhere else in the app.
            */}
            <Controller
              control={control}
              name="target_date"
              render={({ field }) => (
                <DatePicker
                  id="target_date"
                  className="w-56"
                  value={(field.value as string) ?? null}
                  onChange={(value) => field.onChange(value ?? "")}
                  invalid={Boolean(errors.target_date)}
                />
              )}
            />
            <p className="text-xs text-muted-foreground">
              When you need this by. A team leader may propose a different date.
            </p>
            {errors.target_date ? (
              <p className="text-sm text-destructive">{String(errors.target_date.message)}</p>
            ) : null}
          </div>

          </fieldset>
        </div>

        {/*
          Every field this form was BUILT with, rendered from the same component
          map the builder previews them in (lib/form-builder/components.tsx). It
          replaces a `form.fields.map(...)` that switched on `field_type` and
          drew each control inline — the switch that had to stay in step with
          `buildFieldSchema` by hand.

          ⚠️ OUTSIDE THE "Your request" FIELDSET SINCE PHASE 7. It used to sit
          inside it, which was harmless while the form was one page — but a page
          break puts pages two onwards under a legend reading "Your request" that
          belongs to three fixed fields on page one. The built questions are
          their own pages now, with their own headings.
        */}
        <InterpreterFields interpreterStore={interpreterStore} activePage={page} />

        {/*
          ⚠️ THE ATTACHMENT SLOT IS ON THE LAST PAGE, WITH THE SUBMIT BUTTON.
          `vizserve_pms_submit_request` refuses the whole submission without a
          file, so the control that satisfies it has to be on the page carrying
          the button that trips it — a required upload two pages back is a
          refusal with nothing on screen to act on.
        */}
        <div hidden={page !== pages.length - 1}>
          {needsOwnAttachment ? (
            <div className="space-y-2">
              <Label htmlFor="request_attachment">
                Attachment
                <span className="text-destructive" aria-label="required">
                  *
                </span>
              </Label>
              <p className="text-xs text-muted-foreground">
                This request cannot be submitted without a file.
              </p>
              <FileField
                id="request_attachment"
                formId={form.id}
                // null, not a made-up key. There is no `form_fields` row behind
                // this slot, and `pending_attachments.field_key` is nullable for
                // exactly that case — a synthetic key would look like a field
                // that once existed and was deleted.
                fieldKey={null}
                value={formAttachments}
                onChange={(next) => {
                  setFormAttachments(next);
                  if (next.length > 0) setAttachmentError(null);
                }}
                upload={uploadPublicAttachment}
                accept={accept}
                // The form's own rules, same as a `file` field gets through the
                // runtime context. Without it this slot fell back to
                // `FileField`'s hard-coded 10 and ignored a form configured
                // `max_files: 3`.
                maxFiles={maxFiles}
                maxBytes={maxBytes}
              />
              {attachmentError ? (
                <p className="text-sm text-destructive" role="alert">
                  {attachmentError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {formError ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <FormPageNav
          page={page}
          pageCount={pages.length}
          onBack={back}
          onContinue={onContinue}
          submit={
            <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center">
              <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
                {isSubmitting ? "Submitting…" : "Submit request"}
              </Button>
              {/* What happens next, next to the button that makes it happen. */}
              <p className="text-xs text-muted-foreground">
                A team leader reviews this and may propose a different date.
              </p>
            </div>
          }
        />
      </form>
    </FieldRuntimeProvider>
  );
}

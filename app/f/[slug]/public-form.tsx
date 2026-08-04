"use client";

import { useMemo, useState } from "react";
import { useForm, Controller, type Path, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileField } from "@/components/file-field";
import {
  buildSubmissionSchema,
  type AttachmentRef,
  type PublicForm,
  type PublicFormField,
} from "@/lib/schemas/forms";
import { submitPublicRequest, uploadPublicAttachment } from "./actions";

function FieldShell({
  field,
  error,
  children,
}: {
  field: PublicFormField;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={field.field_key}>
        {field.label}
        {field.is_required ? (
          <span className="text-destructive" aria-label="required">
            *
          </span>
        ) : (
          <span className="text-xs font-normal text-muted-foreground">(optional)</span>
        )}
      </Label>
      {field.help_text ? (
        <p className="text-xs text-muted-foreground">{field.help_text}</p>
      ) : null}
      {children}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The value shape is stable even though the schema is generated: core fields
 * plus an open bag of per-form answers. Typing it concretely keeps `register`
 * and `setError` honest, which `as never` everywhere does not.
 */
type SubmissionFormValues = {
  requester_name: string;
  requester_email: string;
  requester_org: string;
  title: string;
  description: string;
  target_date: string;
  field_values: Record<string, unknown>;
};

export function PublicFormRenderer({ form }: { form: PublicForm }) {
  const schema = useMemo(() => buildSubmissionSchema(form), [form]);
  const [submitted, setSubmitted] = useState<{ reference_no: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const rules = form.attachment_rules;
  const maxBytes = rules?.max_bytes;
  // A filter on the file dialog, not a control. The server checks the actual
  // bytes; this only spares the client picking something that cannot work.
  const accept = rules?.allowed_mime_types.length ? rules.allowed_mime_types.join(",") : undefined;

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SubmissionFormValues>({
    resolver: zodResolver(schema) as unknown as Resolver<SubmissionFormValues>,
    defaultValues: {
      requester_name: "",
      requester_email: "",
      requester_org: "HFSE",
      title: "",
      description: "",
      target_date: "",
      field_values: Object.fromEntries(
        form.fields.map((field) => [
          field.field_key,
          field.field_type === "multiselect" || field.field_type === "file" ? [] : "",
        ]),
      ),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    // Files are already uploaded and live under their own field keys; the
    // submission carries the receipts. Flattened here rather than kept in
    // field_values, because the database stores files in request_attachments and
    // field_values holds answers.
    const attachments = form.fields
      .filter((field) => field.field_type === "file")
      .flatMap((field) => (values.field_values[field.field_key] as AttachmentRef[] | undefined) ?? []);

    const result = await submitPublicRequest({
      slug: form.slug,
      payload: values,
      attachments,
      honeypot: (document.getElementById("company_website") as HTMLInputElement | null)?.value ?? "",
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
      for (const [key, message] of Object.entries(result.field_errors)) {
        const path = key in values ? key : `field_values.${key}`;
        setError(path as Path<SubmissionFormValues>, { type: "server", message });
      }
      setFormError("Please correct the highlighted fields.");
      return;
    }

    setFormError("Something went wrong. Please try again.");
  });

  if (submitted) {
    return (
      <div className="rounded-xl bg-card ring-1 ring-foreground/10 p-8 text-center">
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

  const fieldErrors = (errors.field_values ?? {}) as Record<string, { message?: string }>;

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {/* Honeypot (P1-15). Hidden from people, not from bots. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="company_website">Company website</label>
        <input id="company_website" name="company_website" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset className="space-y-4">
        <legend className="mb-3 text-sm font-semibold">Your details</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="requester_name">
              Your name<span className="text-destructive">*</span>
            </Label>
            <Input id="requester_name" {...register("requester_name")} />
            {errors.requester_name ? (
              <p className="text-sm text-destructive">{String(errors.requester_name.message)}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="requester_email">
              Email<span className="text-destructive">*</span>
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
        <legend className="mb-3 text-sm font-semibold">Your request</legend>

        <div className="space-y-2">
          <Label htmlFor="title">
            Title<span className="text-destructive">*</span>
          </Label>
          <Input id="title" {...register("title")} />
          {errors.title ? (
            <p className="text-sm text-destructive">{String(errors.title.message)}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">
            Description<span className="text-destructive">*</span>
          </Label>
          <Textarea id="description" rows={4} {...register("description")} />
          {errors.description ? (
            <p className="text-sm text-destructive">{String(errors.description.message)}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="target_date">
            Target date<span className="text-destructive">*</span>
          </Label>
          <Input id="target_date" type="date" className="w-auto" {...register("target_date")} />
          <p className="text-xs text-muted-foreground">
            When you need this by. A team leader may propose a different date.
          </p>
          {errors.target_date ? (
            <p className="text-sm text-destructive">{String(errors.target_date.message)}</p>
          ) : null}
        </div>

        {form.fields.map((field) => {
          const error = fieldErrors[field.field_key]?.message;
          const name = `field_values.${field.field_key}` as const;

          if (field.field_type === "textarea") {
            return (
              <FieldShell key={field.id} field={field} error={error}>
                <Textarea id={field.field_key} rows={4} {...register(name as never)} />
              </FieldShell>
            );
          }

          if (field.field_type === "select") {
            return (
              <FieldShell key={field.id} field={field} error={error}>
                <Controller
                  control={control}
                  name={name as never}
                  render={({ field: controlled }) => (
                    <Select
                      value={(controlled.value as string) || ""}
                      onValueChange={controlled.onChange}
                    >
                      <SelectTrigger id={field.field_key}>
                        <SelectValue placeholder="Choose one" />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </FieldShell>
            );
          }

          if (field.field_type === "multiselect") {
            return (
              <FieldShell key={field.id} field={field} error={error}>
                <Controller
                  control={control}
                  name={name as never}
                  render={({ field: controlled }) => {
                    const selected = (controlled.value as string[]) ?? [];
                    return (
                      <div className="space-y-2 rounded-md border p-3">
                        {field.options.map((option) => (
                          <label key={option} className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={selected.includes(option)}
                              onCheckedChange={(checked) =>
                                controlled.onChange(
                                  checked
                                    ? [...selected, option]
                                    : selected.filter((value) => value !== option),
                                )
                              }
                            />
                            {option}
                          </label>
                        ))}
                      </div>
                    );
                  }}
                />
              </FieldShell>
            );
          }

          if (field.field_type === "file") {
            return (
              <FieldShell key={field.id} field={field} error={error}>
                <Controller
                  control={control}
                  name={name as never}
                  render={({ field: controlled }) => (
                    <FileField
                      id={field.field_key}
                      formId={form.id}
                      fieldKey={field.field_key}
                      value={(controlled.value as AttachmentRef[] | undefined) ?? []}
                      onChange={controlled.onChange}
                      upload={uploadPublicAttachment}
                      accept={accept}
                      maxBytes={maxBytes}
                    />
                  )}
                />
              </FieldShell>
            );
          }

          const inputType =
            field.field_type === "date"
              ? "date"
              : field.field_type === "email"
                ? "email"
                : field.field_type === "number"
                  ? "number"
                  : "text";

          return (
            <FieldShell key={field.id} field={field} error={error}>
              <Input
                id={field.field_key}
                type={inputType}
                className={inputType === "date" ? "w-auto" : undefined}
                {...register(name as never)}
              />
            </FieldShell>
          );
        })}
      </fieldset>

      {formError ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
        {isSubmitting ? "Submitting…" : "Submit request"}
      </Button>
    </form>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { Chip } from "@/components/status-badge";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { FormSettings } from "../form-settings";
import {
  optionsFromRow,
  reconcileFormSchema,
  type FormFieldRow,
} from "@/lib/form-builder/schema";
import type { FieldType } from "@/lib/schemas/forms";
import { FieldBuilder } from "./field-builder";
import { loadRoutableDepartments } from "../routable-departments";

export const metadata: Metadata = { title: "Edit form" };

/** The crumb back to the list, shared by the page and its failure state. */
function BackToForms() {
  return (
    <Link
      href="/forms"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      Forms
    </Link>
  );
}

/**
 * ⚠️ THE BUILDER IS NOT RENDERED ON A FAILED READ, and this is the shape of
 * that refusal.
 *
 * `QueryError` everywhere else in the app separates "this did not load" from
 * "there is nothing here" so that an empty screen cannot talk somebody out of
 * reporting a fault. Here it does something stronger: it is the only thing
 * standing between a dropped query and DATA LOSS. See the note on the fields
 * read below.
 *
 * The name is passed when it is known, so the shell breadcrumb still says which
 * form failed rather than showing the raw UUID from the URL.
 */
function FormLoadFailure({
  formName,
  what,
  message,
}: {
  formName?: string;
  what: string;
  message?: string;
}) {
  return (
    <PageShell className="mx-auto w-full max-w-5xl">
      {formName ? <BreadcrumbLabel value={formName} /> : null}
      <BackToForms />
      <QueryError what={what} message={message} />
    </PageShell>
  );
}

export default async function EditFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  // RLS decides visibility, so an out-of-scope id simply returns nothing —
  // which is a 404 to the caller rather than a "forbidden" that confirms the
  // form exists.
  const { data: form, error: formError } = await supabase
    .from("vizserve_pms_forms")
    .select(
      "id, name, slug, description, department_id, reference_prefix, is_public, is_active, requires_attachment, sla_minutes, default_list_id, client_approval_days, schema",
    )
    .eq("id", id)
    .maybeSingle();

  // Told apart, rather than both becoming `notFound()`. "No such form" and "the
  // query died" are different sentences, and only one of them is worth
  // reporting to support.
  if (formError) return <FormLoadFailure what="this form" message={formError.message} />;

  if (!form) notFound();

  /*
   * ⚠️ `created_at` IS LOAD-BEARING, NOT PADDING, and `FormFieldRow` requires it
   * so that this select cannot quietly lose it. The projection orders
   * `sort_order, created_at, id` because the migration's backfill does, and live
   * forms share `sort_order` values — drop the column and tied fields would be
   * ordered differently here than by the SQL twin, on the oldest forms and
   * silently.
   */
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("vizserve_pms_form_fields")
    .select(
      "id, label, field_key, field_type, help_text, options, is_required, is_active, sort_order, created_at",
    )
    .eq("form_id", id)
    .order("sort_order");

  // P2-06 — scoped by RLS to the departments this person leads.
  const { data: lists, error: listsError } = await supabase
    .from("vizserve_pms_lists")
    .select("id, name, department_id, form_id")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");

  const { count: submissionCount, error: countError } = await supabase
    .from("vizserve_pms_requests")
    .select("id", { count: "exact", head: true })
    .eq("form_id", id);

  /*
   * ⚠️ A TEAM LEADER WHO LEADS NOTHING IS NOT A FAILED READ.
   *
   * This used to narrow with `.in("id", [""])`, and `""` is not a uuid — the
   * query ALWAYS came back `invalid input syntax for type uuid: ""` (22P02) for
   * that person. Harmless while the error was discarded; a hard page failure the
   * moment `departmentsError` joined the group below, because the state is
   * reachable: a newly created team leader with no department mapping can create
   * an unrouted form (`department_id is null`) and read it back through "forms
   * readable by author while unrouted", so `notFound()` does not fire and the
   * builder is replaced by `FormLoadFailure` on every load.
   *
   * `loadRoutableDepartments` answers that with an empty list and no round trip,
   * and keeps a genuine failure in `error`. See the note there.
   */
  const { departments, error: departmentsError } = await loadRoutableDepartments(
    supabase,
    context,
  );

  /*
   * ⚠️ A FAILED FIELDS READ MUST NOT OPEN THE BUILDER. THIS IS THE DESTRUCTIVE
   * ONE.
   *
   * `error` used to be discarded here and the rows read as `fieldRows ?? []`, so
   * a dropped connection looked exactly like a form with no fields.
   * `reconcileFormSchema` would then find the rows and the stored blob
   * disagreeing, decide — correctly, by its own rule — that the rows win, and
   * hand the builder an EMPTY schema. The next save projects that empty schema
   * back through `vizserve_pms_save_form_schema`, whose step 2 deletes every
   * field row no request answers. One transient failure, and a form's fields are
   * gone. That is the precise outcome the reconcile comment below claims to
   * prevent, committed by the read that feeds it.
   *
   * `vizserve_pms_form_field_protect` still refuses to drop a field that HAS
   * answers, so the damage stops at the fields nobody has filled in yet — which
   * on the four live forms, all of which have zero field rows and zero stored
   * answers, is all of them.
   *
   * The rest are grouped with it rather than tolerated separately:
   *   - `submissionCount` decides `hasSubmissions`, which is what stops a slug
   *     or a reference prefix being changed under live requests. A dropped count
   *     reads as zero and unlocks it.
   *   - `lists` and `departments` fill two `<Select>`s in the settings card. An
   *     empty one is a form whose owning department appears unset, and saving
   *     that screen writes what it shows. Note this catches a FAILURE only: an
   *     empty `departments` with no error is a team leader who leads nothing,
   *     which is a real answer and renders the picker empty as it always did.
   *
   * Every one of them turns a read failure into a WRITE, which is why none of
   * them is allowed to reach the render.
   */
  const readFailure = fieldsError ?? countError ?? listsError ?? departmentsError;

  if (readFailure) {
    return (
      <FormLoadFailure
        formName={form.name}
        what="this form's fields and settings"
        message={readFailure.message}
      />
    );
  }

  /*
   * `options` is `Json` on the row type and `string[]` in the projection.
   *
   * ⚠️ NOT NARROWED — REFUSED. This used to filter the non-strings out, which
   * looked like a display-time courtesy and was not: the filtered list is the
   * schema the builder edits and the next save writes back over the row, so the
   * hidden entries would have been permanently dropped from the stored choices.
   * See `optionsFromRow`. The column's own CHECK makes this unreachable through
   * the app, so refusing costs nothing and losing a choice would be silent.
   */
  const fields: FormFieldRow[] = [];
  let unreadableField: string | null = null;

  for (const row of fieldRows ?? []) {
    const options = optionsFromRow(row.options);

    if (options === null) {
      unreadableField = row.field_key;
      break;
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

  if (unreadableField !== null) {
    return (
      <FormLoadFailure
        formName={form.name}
        what="this form's fields"
        message={`The field "${unreadableField}" has an option list this builder cannot open without rewriting it.`}
      />
    );
  }

  /*
   * ⚠️ P7-66 Phase 2 — THE BLOB IS RECONCILED AGAINST THE ROWS BEFORE IT IS
   * TRUSTED, and the rows win.
   *
   * Phase 1's dual-write logged and swallowed a failed blob write on the
   * argument that the next save re-derives it. That does not cover the last save
   * before a form is published and left alone — and that form's stale blob,
   * opened here and saved back, would have
   * `vizserve_pms_save_form_schema` project it over the rows and DELETE every
   * field it omits. So the builder opens on what the rows say.
   *
   * Which is only true because the read above is now checked: "the rows say
   * nothing" and "the rows did not arrive" are the same value to this function.
   *
   * The disagreement is logged rather than merely repaired: a stale blob is a
   * Phase 1 write that never landed, and it is worth knowing it happened.
   */
  const { schema: initialSchema, storedWasCurrent } = reconcileFormSchema(form.schema, fields);

  if (!storedWasCurrent) {
    console.warn("[P7-66] stored form schema disagreed with the rows; using the rows", {
      formId: form.id,
    });
  }

  return (
    // Wider than the old max-w-3xl. This page is a builder, not a document: the
    // settings card lays its fields out in two and three columns, and the narrow
    // measure squeezed "Owning department" and "Reference prefix" into a width
    // where neither could show its own value. max-w-5xl keeps a sensible line
    // length for the description textarea while giving those rows room.
    <PageShell className="mx-auto w-full max-w-5xl">
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={form.name} />

      <div>
        <BackToForms />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{form.name}</h1>
          {form.is_active ? <Chip tone="success" label="Live" /> : <Chip tone="neutral" label="Draft" />}
          {form.is_active && form.is_public ? (
            <Link
              href={`/request/${form.slug}`}
              target="_blank"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              View public form
              <ExternalLink className="size-3" />
            </Link>
          ) : null}
        </div>
        {submissionCount && submissionCount > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {submissionCount} submission{submissionCount === 1 ? "" : "s"} — field keys are locked.
          </p>
        ) : null}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Fields</h2>
        <FieldBuilder formId={form.id} initialSchema={initialSchema} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Settings</h2>
        <div className="rounded-lg border bg-card grade-surface p-6 shadow-raised-lg">
          <FormSettings
            departments={departments}
            lists={lists ?? []}
            formId={form.id}
            hasSubmissions={Boolean(submissionCount && submissionCount > 0)}
            initial={{
              name: form.name,
              slug: form.slug,
              description: form.description,
              department_id: form.department_id,
              reference_prefix: form.reference_prefix,
              is_public: form.is_public,
              is_active: form.is_active,
              requires_attachment: form.requires_attachment,
              sla_minutes: form.sla_minutes,
              default_list_id: form.default_list_id,
              client_approval_days: form.client_approval_days,
            }}
          />
        </div>
      </section>
    </PageShell>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { requireRole, roleAtLeast } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { FormSettings } from "../form-settings";
import { FieldBuilder, type FieldRow } from "./field-builder";

export const metadata: Metadata = { title: "Edit form" };

export default async function EditFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  // RLS decides visibility, so an out-of-scope id simply returns nothing —
  // which is a 404 to the caller rather than a "forbidden" that confirms the
  // form exists.
  const { data: form } = await supabase
    .from("vizserve_pms_forms")
    .select(
      "id, name, slug, description, department_id, reference_prefix, is_public, is_active, requires_attachment, sla_days",
    )
    .eq("id", id)
    .maybeSingle();

  if (!form) notFound();

  const { data: fieldRows } = await supabase
    .from("vizserve_pms_form_fields")
    .select("id, label, field_key, field_type, help_text, options, is_required, is_active, sort_order")
    .eq("form_id", id)
    .order("sort_order");

  const { count: submissionCount } = await supabase
    .from("vizserve_pms_requests")
    .select("id", { count: "exact", head: true })
    .eq("form_id", id);

  const departmentQuery = supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .eq("is_active", true);
  if (!roleAtLeast(context.role, "admin")) {
    departmentQuery.in(
      "id",
      context.managedDepartmentIds.length > 0 ? context.managedDepartmentIds : [""],
    );
  }
  const { data: departments } = await departmentQuery.order("name");

  const fields: FieldRow[] = (fieldRows ?? []).map((f) => ({
    id: f.id,
    label: f.label,
    field_key: f.field_key,
    field_type: f.field_type,
    help_text: f.help_text,
    options: Array.isArray(f.options) ? (f.options as string[]) : [],
    is_required: f.is_required,
    is_active: f.is_active,
    sort_order: f.sort_order,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/forms"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Forms
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{form.name}</h1>
          {form.is_active ? (
            <span className="rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success">
              Live
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
              Draft
            </span>
          )}
          {form.is_active && form.is_public ? (
            <Link
              href={`/f/${form.slug}`}
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
        <FieldBuilder formId={form.id} fields={fields} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Settings</h2>
        <div className="rounded-lg border bg-card p-6 shadow-ring">
          <FormSettings
            departments={departments ?? []}
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
              sla_days: form.sla_days,
            }}
          />
        </div>
      </section>
    </div>
  );
}

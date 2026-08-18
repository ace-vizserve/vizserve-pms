import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Forms" };

type FormRow = {
  id: string;
  name: string;
  slug: string;
  is_public: boolean;
  is_active: boolean;
  reference_prefix: string;
  department_id: string | null;
};

/**
 * P1-05 — forms list.
 *
 * Department-scoped by RLS, so this query needs no `.eq()` on department: a TL
 * who leads VizMedia sees VizMedia's forms and nothing else, and the same query
 * run by an admin returns everything. That is deliberate — the filter lives in
 * one place (the policy) rather than being restated at every call site.
 *
 * No <h1>. The shell breadcrumb is the page label.
 */
export default async function FormsPage() {
  await requireRole("team_leader");
  const supabase = await createClient();

  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, slug, is_public, is_active, reference_prefix, department_id, updated_at")
    .order("updated_at", { ascending: false });

  const { data: departments } = await supabase.from("vizserve_pms_departments").select("id, name");

  const departmentName = new Map((departments ?? []).map((d) => [d.id, d.name]));
  const rows = (forms ?? []) as FormRow[];

  const columns: Column<FormRow>[] = [
    {
      key: "form",
      header: "Form",
      cell: (form) => (
        <>
          <Link href={`/forms/${form.id}`} className="font-medium hover:underline">
            {form.name}
          </Link>
          <span className="ml-2 text-xs text-muted-foreground">{form.reference_prefix}</span>
        </>
      ),
    },
    {
      key: "department",
      header: "Department",
      className: "hidden sm:table-cell text-muted-foreground",
      cell: (form) =>
        form.department_id ? (
          departmentName.get(form.department_id)
        ) : (
          // A form with no department has nowhere to route a submission, which
          // is a fault rather than a blank.
          <span className="text-warning">Not routed</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (form) =>
        /* Status is never colour alone — the label carries it. */
        form.is_active ? (
          <span className="rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success">
            Live
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
            Draft
          </span>
        ),
    },
    {
      key: "url",
      header: "Public URL",
      className: "hidden md:table-cell",
      cell: (form) =>
        form.is_active && form.is_public ? (
          <Link
            href={`/f/${form.slug}`}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            /f/{form.slug}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <PageShell>
      <div className="flex items-center justify-end">
        <Link href="/forms/new" className={buttonVariants({ size: "sm" })}>
          <Plus />
          New form
        </Link>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(form) => form.id}
        /* This list has no filters, so there is only one way to be empty. */
        empty={
          <EmptyState
            icon={<FileText />}
            title="No forms yet"
            description="A form defines what a client must tell you before the team will accept the work. Every required field is a question you will never have to chase."
            action={
              <Link
                href="/forms/new"
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                Create the first form
              </Link>
            }
          />
        }
      />
    </PageShell>
  );
}

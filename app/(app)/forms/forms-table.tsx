"use client";

import { FileText } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { DataTableColumns, useColumnVisibility } from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import { Chip } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { FORM_PURPOSE_LABELS, type FormPurpose } from "@/lib/schemas/forms";

/**
 * P7-64 — the columns, in a client component, because the table is one now.
 *
 * `cell` is a function and a function cannot cross the RSC boundary. The server
 * page keeps the auth and the query; this file knows only how to draw a row.
 *
 * ⚠️ NO `urlSort` HERE, AND THAT IS CORRECT. This query is neither paginated
 * nor capped — the page holds every form it is allowed to see — so sorting in
 * the browser reorders the whole list and is honest. Adding a cap later means
 * adding `urlSort` in the same change.
 */

export type FormRow = {
  id: string;
  name: string;
  slug: string;
  purpose: FormPurpose;
  is_public: boolean;
  is_active: boolean;
  reference_prefix: string;
  department_id: string | null;
  created_at: string;
};

export function FormsTable({
  rows,
  departmentNames,
}: {
  rows: FormRow[];
  departmentNames: Record<string, string>;
}) {
  const { visibility, onVisibilityChange } = useColumnVisibility("forms");

  const columns: Column<FormRow>[] = [
    {
      key: "created_at",
      hideable: true,
      header: "Created at",
      className: "max-w-xs",
      cell: (form) => <p className="truncate">{formatDate(form.created_at)}</p>,
    },
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
      /*
       * P7-66 — WHAT THE FORM IS, beside what state it is in.
       *
       * Two chips in one row could read as one status split in two, which is
       * why this one is worded as a noun ("Client", "Internal") and Status is
       * worded as a state ("Live", "Draft"), and why the tones are drawn from
       * the two families Status never uses. The LABEL carries it either way —
       * greyscale this table and both columns still say what they say.
       */
      key: "type",
      hideable: true,
      header: "Type",
      cell: (form) => (
        <Chip
          tone={form.purpose === "CLIENT_REQUEST" ? "brand" : "info"}
          label={FORM_PURPOSE_LABELS[form.purpose].short}
        />
      ),
    },
    {
      key: "department",
      hideable: true,
      header: "Department",
      className: "hidden sm:table-cell text-muted-foreground",
      cell: (form) =>
        form.department_id ? (
          departmentNames[form.department_id]
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
        form.is_active ? <Chip tone="success" label="Live" /> : <Chip tone="neutral" label="Draft" />,
    },
    {
      key: "url",
      hideable: true,
      header: "Public URL",
      className: "hidden md:table-cell",
      cell: (form) =>
        form.is_active && form.is_public ? (
          <Link
            target="_blank"
            href={`/request/${form.slug}`}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            /request/{form.slug}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];


  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <DataTableColumns
          columns={columns}
          visibility={visibility}
          onVisibilityChange={onVisibilityChange}
        />
      </div>

      <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
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
            <Link href="/forms/new" className={buttonVariants({ size: "sm", variant: "outline" })}>
              Create the first form
            </Link>
          }
        />
      }
      />
    </div>
  );
}

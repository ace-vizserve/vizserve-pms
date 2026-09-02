"use client";

import { FileText } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import { Chip } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatDuration } from "@/lib/dates";
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
  sla_minutes: number | null;
  requires_attachment: boolean;
};

export function FormsTable({
  rows,
  departmentNames,
  submissionCounts,
  lastSubmission,
  submissionsReadable,
}: {
  rows: FormRow[];
  departmentNames: Record<string, string>;
  /** Form id → how many requests it has taken. */
  submissionCounts: Record<string, number>;
  /** Form id → the newest submission's timestamp. */
  lastSubmission: Record<string, string>;
  /**
   * Per form: may this viewer read its submissions at all?
   *
   * ⚠️ "NOT PERMITTED" IS NOT "NONE", and on this column the difference is the
   * whole point. `vizserve_pms_requests` is still scoped by
   * `manages_department`, which the P8-01c department-admin tick deliberately
   * does NOT grant — client submissions carry requester names, emails and free
   * text, and reading them is not one of the powers the tick confers. So a
   * department admin's query returns zero rows for a form with real traffic,
   * and printing "None" would report a busy intake as an unused one.
   */
  submissionsReadable: Record<string, boolean>;
}) {

  const columns: Column<FormRow>[] = [
    {
      key: "created_at",
      sortKey: "created",
      hideable: true,
      header: "Created at",
      className: "max-w-xs",
      cell: (form) => <p className="truncate">{formatDate(form.created_at)}</p>,
    },
    {
      key: "form",
      sortKey: "name",
      // ⚠️ THE COLUMN IS KEYED `form` AND THE FIELD IS `name`, so the default
      // accessor reads nothing at all — the header sorted alphabetically by
      // `undefined`, which is to say not at all.
      sortValue: (form) => form.name,
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
      sortKey: "department",
      /* The row holds `department_id`, an opaque uuid, and nothing called
         `department` — so sorting had no value to read, and reading the id
         would have ordered the column by something invisible. The NAME is what
         the cell prints. An unrouted form sorts under its own words rather than
         to the top of an alphabet it is not part of. */
      sortValue: (form) =>
        form.department_id ? (departmentNames[form.department_id] ?? "") : "Not routed",
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
      sortKey: "status",
      // The state is the boolean `is_active`; there is no `status` field. Sorts
      // on the chip's own words, so "Draft" and "Live" group the way they read.
      sortValue: (form) => (form.is_active ? "Live" : "Draft"),
      header: "Status",
      cell: (form) =>
        /* Status is never colour alone — the label carries it. */
        form.is_active ? <Chip tone="success" label="Live" /> : <Chip tone="neutral" label="Draft" />,
    },
    {
      /*
       * P7-66. A published form nobody has used and one carrying half the
       * department's intake looked identical on this list. The count is the
       * form's own evidence.
       */
      key: "submissions",
      header: "Submissions",
      sortKey: "submissions",
      // The count is in a lookup keyed by form id, not on the row.
      // Unreadable sorts below every real count rather than beside the zeroes:
      // it is not a quantity, and pretending it is one puts "not permitted" in
      // the middle of the ordering.
      sortValue: (form) => (submissionsReadable[form.id] ? (submissionCounts[form.id] ?? 0) : -1),
      hideable: true,
      defaultHidden: true,
      align: "end",
      className: "hidden lg:table-cell tabular-nums",
      cell: (form) => {
        if (!submissionsReadable[form.id]) {
          return (
            <span className="text-foreground-faint" title="You do not have access to this form's submissions.">
              Not shown
            </span>
          );
        }
        const count = submissionCounts[form.id] ?? 0;
        // A live form with no submissions is a real signal — say "None", not a
        // zero somebody reads past.
        return count === 0 ? <span className="text-muted-foreground">None</span> : count;
      },
    },
    {
      key: "last",
      header: "Last used",
      sortKey: "last",
      sortValue: (form) => (submissionsReadable[form.id] ? (lastSubmission[form.id] ?? "") : ""),
      hideable: true,
      defaultHidden: true,
      className: "hidden xl:table-cell whitespace-nowrap text-muted-foreground tabular-nums",
      cell: (form) =>
        !submissionsReadable[form.id] ? (
          <span className="text-foreground-faint" title="You do not have access to this form's submissions.">
            Not shown
          </span>
        ) : lastSubmission[form.id] ? (
          formatDate(lastSubmission[form.id])
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "sla",
      header: "SLA",
      hideable: true,
      defaultHidden: true,
      className: "hidden xl:table-cell whitespace-nowrap text-muted-foreground",
      // What this form promises a decision in. It is the target the /requests
      // SLA column counts down to, and it was only visible inside the editor.
      cell: (form) =>
        form.sla_minutes ? (
          formatDuration(form.sla_minutes)
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "attachment",
      header: "Attachment",
      hideable: true,
      defaultHidden: true,
      className: "hidden 2xl:table-cell",
      cell: (form) =>
        form.requires_attachment ? (
          <Chip tone="info" label="Required" />
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
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

  const { visibility, onVisibilityChange } = useColumnVisibility("forms", columns);

  return (
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
  );
}

"use client";

import { Inbox } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { RequestStatusBadge } from "@/components/status-badge";
import { formatDate, isOverdue } from "@/lib/dates";

/**
 * P7-64 — the columns, in a client component, because the table is one now.
 *
 * `cell` is a function and a function cannot cross the RSC boundary, so the
 * moment `DataTable` moved onto `@tanstack/react-table` every page declaring
 * columns inline had to grow one of these. The server page keeps the auth, the
 * query and the searchParams narrowing; this file knows only how to draw a row.
 *
 * `formNames` arrives as a plain object rather than the `Map` the page built —
 * a Map is not serialisable across the boundary either.
 */

export type RequestRow = {
  id: string;
  reference_no: string;
  title: string;
  requester_name: string;
  requester_org: string;
  target_date: string | null;
  status: "DRAFT" | "SUBMITTED" | "PENDING_REVIEW" | "APPROVED" | "RETURNED" | "REJECTED";
  submitted_at: string;
  form_id: string;
};

export function RequestsTable({
  rows,
  formNames,
  isFiltered,
  errorMessage,
}: {
  rows: RequestRow[];
  formNames: Record<string, string>;
  isFiltered: boolean;
  errorMessage?: string;
}) {
  const columns: Column<RequestRow>[] = [
    {
      key: "submitted_at",
      header: "Submitted at",
      className: "max-w-xs",
      sortKey: "submitted",
      cell: (request) => <p className="truncate">{formatDate(request.submitted_at)}</p>,
    },
    {
      key: "reference",
      header: "Reference",
      className: "whitespace-nowrap",
      sortKey: "reference",
      cell: (request) => (
        <>
          <Link href={`/requests/${request.id}`} className="font-medium hover:underline">
            {request.reference_no}
          </Link>
          <p className="text-xs text-muted-foreground">{formNames[request.form_id] ?? "—"}</p>
        </>
      ),
    },
    {
      key: "title",
      header: "Request",
      className: "max-w-xs",
      sortKey: "title",
      hideable: true,
      cell: (request) => <p className="truncate">{request.title}</p>,
    },
    {
      key: "requester",
      header: "Requester",
      className: "hidden md:table-cell",
      sortKey: "requester",
      hideable: true,
      cell: (request) => (
        <>
          <p className="truncate">{request.requester_name}</p>
          <p className="text-xs text-muted-foreground">{request.requester_org}</p>
        </>
      ),
    },
    {
      key: "target",
      header: "Target date",
      className: "hidden sm:table-cell whitespace-nowrap",
      sortKey: "target",
      cell: (request) => (
        <>
          {formatDate(request.target_date)}
          {/* Overdue is said in words as well as colour — a red date alone is
              invisible to a meaningful share of people, and to anyone reading
              a printed or screenshotted queue. */}
          {isOverdue(request.target_date) && request.status === "PENDING_REVIEW" ? (
            <p className="text-xs font-medium text-destructive">Overdue</p>
          ) : null}
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (request) => <RequestStatusBadge status={request.status} />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(request) => request.id}
      /* Capped at 200 rows on the server, so the browser must not pretend to
         sort the whole queue. */
      urlSort
      empty={
        errorMessage ? (
          <QueryError what="requests" message={errorMessage} />
        ) : isFiltered ? (
          <EmptyState
            icon={<Inbox />}
            title="No requests match these filters"
            description="Widen the date range or clear the status filter to see the rest of the queue."
          />
        ) : (
          <EmptyState
            icon={<Inbox />}
            title="Nothing here yet"
            description="Requests appear when a client submits one of your published forms. If you are expecting one, check the form is published and routed to your department."
          />
        )
      }
    />
  );
}

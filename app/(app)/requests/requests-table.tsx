"use client";

import { Inbox } from "lucide-react";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import {
  useColumnVisibility,
} from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { RequestStatusBadge } from "@/components/status-badge";
import { TableSkeleton } from "@/components/skeletons";
import { formatDate, formatDuration, isOverdue } from "@/lib/dates";
import type { RequestListRow } from "@/lib/schemas/requests";

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

/**
 * ⚠️ THE ROW TYPE IS THE CONTRACT'S NOW, NOT A LOCAL DECLARATION. It was written
 * out by hand here — the six status literals included — and had to match, field
 * for field, a `.select()` string in a different file that nothing checked it
 * against. `requestListRowSchema` in `lib/schemas/requests.ts` is parsed on
 * arrival, so a dropped column is a sentence rather than an `undefined` that
 * renders as an em dash and reads as "the client gave no date".
 *
 * The name is kept because this file and its callers say it.
 */
export type RequestRow = RequestListRow;

export function RequestsTable({
  rows,
  formNames,
  formSlaMinutes,
  reviewerNames,
  isFiltered,
  isPending,
  errorMessage,
  toolbar,
  count,
}: {
  rows: RequestRow[];
  formNames: Record<string, string>;
  /** Form id → the minutes that form promises a decision in. */
  formSlaMinutes: Record<string, number>;
  /** Reviewer id → name. A Map cannot cross the RSC boundary. */
  reviewerNames: Record<string, string>;
  isFiltered: boolean;
  /** No rows have arrived yet — draw a skeleton, never an empty state. */
  isPending: boolean;
  errorMessage?: string;
  /** Search and filters, for the table's own header strip. */
  toolbar?: React.ReactNode;
  count?: React.ReactNode;
}) {

  const columns: Column<RequestRow>[] = [
    {
      key: "submitted_at",
      header: "Submitted at",
      className: "max-w-xs",
      sortKey: "submitted",
      cell: (request) => (
        <p className="truncate">{formatDate(request.submitted_at)}</p>
      ),
    },
    {
      key: "reference",
      header: "Reference",
      /* The row's identity. With SLA, Agreed and Reviewed-by all switchable on,
         this table can outgrow its width — and a reference number that scrolls
         away leaves rows nobody can tell apart. */
      pin: "left",
      className: "whitespace-nowrap",
      sortKey: "reference",
      cell: (request) => (
        <>
          <Link
            href={`/requests/${request.id}`}
            className="font-medium hover:underline"
          >
            {request.reference_no}
          </Link>
          <p className="text-xs text-muted-foreground">
            {formNames[request.form_id] ?? "—"}
          </p>
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
          <p className="text-xs text-muted-foreground">
            {request.requester_org}
          </p>
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
          {isOverdue(request.target_date) &&
          request.status === "PENDING_REVIEW" ? (
            <p className="text-xs font-medium text-destructive">Overdue</p>
          ) : null}
        </>
      ),
    },
    {
      /*
       * P7-66 — THE CLOCK GATE 1 IS RUNNING AGAINST.
       *
       * `sla_started_at` sits on the request and `sla_minutes` on its form, and
       * neither was ever shown — so the queue could not answer the question a
       * Team Leader opens it to ask: what is about to breach.
       *
       * ⚠️ ONLY WHILE THE CLOCK IS STILL RUNNING. A decided request has stopped
       * it, and "3h left" against something already approved would describe a
       * race nobody is in. Anything not awaiting review reads as an em dash.
       */
      key: "sla",
      header: "SLA",
      hideable: true,
      defaultHidden: true,
      className: "hidden lg:table-cell whitespace-nowrap",
      cell: (request) => {
        const minutes = formSlaMinutes[request.form_id];
        if (request.status !== "PENDING_REVIEW" || !request.sla_started_at || !minutes) {
          return <span className="text-foreground-faint">—</span>;
        }

        const dueAt = new Date(request.sla_started_at).getTime() + minutes * 60_000;
        const leftMinutes = Math.round((dueAt - Date.now()) / 60_000);

        // Never colour alone — "overdue" and "left" carry it; the tone is the
        // second reading.
        if (leftMinutes <= 0) {
          return (
            <span className="font-medium text-destructive">
              {formatDuration(Math.abs(leftMinutes))} overdue
            </span>
          );
        }

        return (
          <span className={leftMinutes < 120 ? "font-medium text-warning" : undefined}>
            {formatDuration(leftMinutes)} left
          </span>
        );
      },
    },
    {
      /*
       * P7-66 — THE DATE THAT WAS ACTUALLY AGREED.
       *
       * `target_date` is what the client ASKED for; `approved_target_date` is
       * what the lead committed to at Gate 1, and the delta between them is the
       * only measurable evidence that the gate does anything (P2-03). The queue
       * showed the ask and never the promise.
       */
      key: "agreed",
      header: "Agreed",
      sortKey: "agreed",
      hideable: true,
      defaultHidden: true,
      className: "hidden lg:table-cell whitespace-nowrap",
      cell: (request) =>
        request.approved_target_date ? (
          <>
            {formatDate(request.approved_target_date)}
            {request.approved_target_date !== request.target_date ? (
              // Same word the detail page uses for the same fact.
              <span className="ml-2 text-xs text-muted-foreground">negotiated</span>
            ) : null}
          </>
        ) : (
          // Not a gap: an undecided request has no agreed date yet.
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "reviewed",
      header: "Reviewed by",
      hideable: true,
      defaultHidden: true,
      className: "hidden xl:table-cell whitespace-nowrap text-muted-foreground",
      cell: (request) =>
        request.reviewed_by ? (
          (reviewerNames[request.reviewed_by] ?? "—")
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (request) => <RequestStatusBadge status={request.status} />,
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("requests", columns);

  return (
    <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(request) => request.id}
      toolbar={toolbar}
      count={count}
        /* Paged on the server, so the browser holds one page and must not
           pretend to sort the whole queue. */
        urlSort
        /* What the query orders by when the URL says nothing. Display only —
           it puts the arrow on the right column instead of leaving every header
           neutral, and it is the same pair `DEFAULT_REQUEST_SORT` in
           `lib/query/fetchers/requests.ts` builds the `.order()` from. Change
           one and change the other or it goes back to lying about it. */
        defaultSort={{ key: "submitted", dir: "desc" }}
        empty={
          /*
           * ⚠️ THREE BRANCHES IN ORDER, AND THE MIDDLE ONE IS NEW IN P12-18:
           * could not load, has not loaded yet, genuinely nothing. The RSC only
           * ever had the first and the last, because a server render has no
           * "not yet" — it either had the rows or it did not. A client query
           * does, and without this branch the reassuring "Nothing here yet.
           * Requests appear when a client submits one of your published forms"
           * would flash over every navigation into the queue.
           */
          errorMessage ? (
            <QueryError what="requests" message={errorMessage} />
          ) : isPending ? (
            <TableSkeleton columns={5} rows={8} />
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
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
      />
  );
}

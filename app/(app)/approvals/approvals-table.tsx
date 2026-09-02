"use client";

import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import { InternalStatusBadge, InternalTypeBadge } from "@/components/status-badge";
import type { InternalRequestRow } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import { richTextToPlainText } from "@/lib/rich-text";
import { requestDetail } from "./request-summary";

/**
 * P7-64 — the columns and the section wrapper, in a client component.
 *
 * `cell` is a function and a function cannot cross the RSC boundary, so this
 * moved out of `page.tsx` when `DataTable` went onto `@tanstack/react-table`.
 * `empty` stays a prop: a rendered element crosses the wire fine, only the
 * closures could not.
 *
 * ⚠️ `urlSort` IS SET. The query takes `APPROVALS_PAGE_SIZE + 1` rows, so the
 * page does not hold the whole queue and the browser must not pretend to sort
 * it. The server reads `?sort=` and orders in Postgres.
 */

export type Row = InternalRequestRow & { vizserve_pms_users: { full_name: string } | null };

function columnsFor(
  showWho: boolean,
  reviewerName?: (id: string) => string | undefined,
): Column<Row>[] {
  return [
    {
      key: "request",
      header: "Request",
      sortKey: "request",
      cell: (request) => (
        <>
          <Link href={`/approvals/${request.id}`} className="font-medium hover:underline">
            {requestDetail(request)}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <InternalTypeBadge type={request.request_type} />
            {showWho ? (
              <span className="text-2xs text-muted-foreground">
                {request.vizserve_pms_users?.full_name ?? "—"}
              </span>
            ) : null}
          </div>
        </>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      hideable: true,
      className: "hidden sm:table-cell max-w-xs",
      /*
       * P7-56. The FLATTENED reason, not the column.
       *
       * `truncate` is `text-overflow: ellipsis` on one line, which cannot do
       * anything useful with a `<ul>` or an `<h3>` — the markup would either
       * render as blocks and blow the row height open or, rendered as text,
       * show the reader a `<p>` tag. Same helper the emails use.
       */
      cell: (request) => (
        <p className="truncate text-muted-foreground">{richTextToPlainText(request.reason)}</p>
      ),
    },
    {
      key: "submitted",
      header: "Submitted",
      sortKey: "submitted",
      className: "hidden md:table-cell whitespace-nowrap text-muted-foreground",
      cell: (request) => formatDate(request.created_at),
    },
    {
      /*
       * P7-66 — WHEN IT WAS SETTLED, AND BY WHOM.
       *
       * The query already selects `*`, so `reviewed_at` and `reviewed_by` were
       * both in hand and neither was shown: a decided row said only that it was
       * decided. On a page people open to chase an approval, "who has it" and
       * "who closed it" are the two questions, and only the first was answerable.
       *
       * Empty on a pending row BY DESIGN — an em dash there is the honest
       * answer, not a gap.
       */
      key: "decided",
      header: "Decided",
      hideable: true,
      defaultHidden: true,
      sortKey: "decided",
      className: "hidden lg:table-cell whitespace-nowrap text-muted-foreground",
      cell: (request) =>
        request.reviewed_at ? (
          <>
            <div className="tabular-nums">{formatDate(request.reviewed_at)}</div>
            {request.reviewed_by ? (
              <div className="text-2xs">{reviewerName?.(request.reviewed_by) ?? ""}</div>
            ) : null}
          </>
        ) : (
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cell: (request) => <InternalStatusBadge status={request.status} />,
    },
  ];
}

export function Section({
  title,
  description,
  rows,
  showWho,
  reviewerNames,
  empty,
}: {
  title: string;
  description: string;
  rows: Row[];
  showWho: boolean;
  /** Reviewer id → name, for the Decided column. A Map cannot cross the wire. */
  reviewerNames?: Record<string, string>;
  empty: React.ReactNode;
}) {
  const columns = columnsFor(showWho, (id) => reviewerNames?.[id]);
  /* Both sections on this page share one storage key deliberately: they are the
     same columns over the same shape, and hiding "Reason" in one while it stays
     in the other would read as the setting not applying. */
  const { visibility, onVisibilityChange } = useColumnVisibility("approvals", columns);

  return (
    <section className="space-y-3">
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(request) => request.id}
        urlSort
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
        /* The section heading IS this table's toolbar. Two tables stacked on one
           page need to say which is which, and a heading floating above an
           unrelated bordered box is the arrangement that made them look like
           captions for the wrong list. */
        toolbar={
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        }
        count={
          <>
            <span className="tabular-nums">{rows.length}</span>{" "}
            {rows.length === 1 ? "request" : "requests"}
          </>
        }
        empty={empty}
      />
    </section>
  );
}


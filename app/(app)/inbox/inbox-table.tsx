"use client";

import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { useColumnVisibility } from "@/components/data-table-columns";
import type { VizservePmsNotificationType } from "@/lib/database.types";
import { formatDateTime } from "@/lib/dates";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * P7-64 — the columns, in a client component, because the table is one now.
 *
 * `cell` is a function and a function cannot cross the RSC boundary. The server
 * page keeps the auth, the query, the searchParams narrowing and the paginator.
 *
 * ⚠️ `urlSort` IS SET, AND ON THIS PAGE IT IS LOAD-BEARING. The inbox renders
 * one `.range()` of a much longer list, so sorting in the browser would reorder
 * 25 rows and present it as an ordering of all of them.
 */

export type Notification = {
  id: string;
  title: string;
  body: string | null;
  link_path: string | null;
  type: VizservePmsNotificationType;
  read_at: string | null;
  emailed_at: string | null;
  created_at: string;
};

export function InboxTable({
  rows,
  empty,
  toolbar,
  count,
}: {
  rows: Notification[];
  empty: React.ReactNode;
  /** Search and filters, for the table's own header strip. */
  toolbar?: React.ReactNode;
  count?: React.ReactNode;
}) {

  const columns: Column<Notification>[] = [
    {
      key: "notification",
      header: "Notification",
      className: "max-w-lg whitespace-normal",
      cell: (item) => (
        <div className="flex items-start gap-2.5">
          {/* Unread is a dot AND a word — the word is `sr-only` because the
              weight of the title carries it visually, but a coloured dot alone
              is not an accessible status. */}
          <span
            aria-hidden
            className={cn(
              "mt-1.75 size-1.5 shrink-0 rounded-full",
              item.read_at ? "bg-transparent" : "bg-primary",
            )}
          />
          <div className="min-w-0">
            {item.link_path ? (
              // Every notification links to the exact record, never to a
              // dashboard the recipient then has to search (docs/12 §3).
              <Link
                href={item.link_path}
                className={cn("text-sm hover:underline", !item.read_at && "font-medium")}
              >
                {item.title}
                {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
              </Link>
            ) : (
              <span className={cn("text-sm", !item.read_at && "font-medium")}>
                {item.title}
                {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
              </span>
            )}
            {item.body ? <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p> : null}
          </div>
        </div>
      ),
    },
    {
      key: "type",
      hideable: true,
      header: "Type",
      sortKey: "type",
      className: "hidden md:table-cell text-xs text-muted-foreground",
      cell: (item) => NOTIFICATION_TYPE_LABELS[item.type] ?? item.type,
    },
    {
      /*
       * P7-66 — the two facts this table showed only as decoration.
       *
       * Unread was a coloured dot beside the title and "emailed" a suffix on
       * the timestamp. Both were readable and neither was SORTABLE, so "show me
       * everything still unread" meant scanning for dots. As columns they can
       * be ordered; hidden by default because the inline forms are enough for
       * the everyday read.
       */
      key: "read",
      header: "Read",
      sortKey: "read",
      hideable: true,
      defaultHidden: true,
      className: "hidden lg:table-cell",
      cell: (item) =>
        item.read_at ? (
          <span className="text-xs text-muted-foreground">Read</span>
        ) : (
          <span className="text-xs font-medium">Unread</span>
        ),
    },
    {
      key: "emailed",
      header: "Emailed",
      sortKey: "emailed",
      hideable: true,
      defaultHidden: true,
      className: "hidden xl:table-cell whitespace-nowrap text-xs text-muted-foreground",
      cell: (item) =>
        item.emailed_at ? (
          formatDateTime(item.emailed_at)
        ) : (
          // Not every notification is emailed — docs/12's inbox-vs-email policy
          // is deliberate, so a blank here is a decision, not a failure.
          <span className="text-foreground-faint">—</span>
        ),
    },
    {
      key: "when",
      hideable: true,
      header: "When",
      sortKey: "when",
      className: "hidden sm:table-cell text-xs text-muted-foreground",
      cell: (item) => (
        <>
          {formatDateTime(item.created_at)}
          {item.emailed_at ? <span className="text-2xs"> · emailed</span> : null}
        </>
      ),
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("inbox", columns);

  return (
    <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
      columns={columns}
      rows={rows}
      getRowKey={(item) => item.id}
      toolbar={toolbar}
      count={count}
      urlSort
      empty={empty}
      />
  );
}

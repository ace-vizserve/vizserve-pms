"use client";

import Link from "next/link";
import { useTransition } from "react";

import { DataTable, type Column } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { useColumnVisibility } from "@/components/data-table-columns";
import type { VizservePmsNotificationType } from "@/lib/database.types";
import { formatDateTime } from "@/lib/dates";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/notifications";
import { richTextToPlainText } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

import { markNotificationRead } from "./actions";

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
            className={cn("mt-1.75 size-1.5 shrink-0 rounded-full", item.read_at ? "bg-transparent" : "bg-primary")}
          />
          <div className="min-w-0">
            {item.link_path ? (
              // Every notification links to the exact record, never to a
              // dashboard the recipient then has to search (docs/12 §3).
              <Link
                href={item.link_path}
                className={cn("text-sm hover:underline", !item.read_at && "font-medium")}
                /*
                 * ⚠️ OPENING IT READS IT, and the request is deliberately NOT
                 * awaited before the link navigates.
                 *
                 * App Router navigation is client-side, so the fetch this
                 * starts survives the page change — awaiting it would put a
                 * server round trip in front of every click on this screen,
                 * for a write nobody is waiting on.
                 *
                 * Fired only when the row is actually unread. A second click
                 * on something read last week is a wasted request, and the
                 * action would ignore it anyway (`.is("read_at", null)`).
                 */
                onClick={() => {
                  if (!item.read_at) void markNotificationRead(item.id);
                }}
              >
                {item.title}
                {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
              </Link>
            ) : (
              /*
               * NO LINK, AND STILL READABLE.
               *
               * A notification with no `link_path` has nowhere to send anybody
               * — but it is still something you look at, and leaving it as the
               * one kind that can only be cleared by "Mark all read" is how a
               * badge stops being trusted.
               *
               * A BUTTON, not a link: it acts rather than navigates, which is
               * the rule the design system states outright. Once read it stops
               * being a control at all — there is nothing left for it to do,
               * and an inert button is worse than plain text.
               */
              <MarkReadTitle item={item} />
            )}
            {/*
              ⚠️ FLATTENED, BECAUSE THE BODY IS MARKUP NOW.

              `vizserve_pms_notify` is called from SQL with the transition
              comment (`p3_tasks_qa.sql`) or the internal request's reason
              (`p5_05_internal_requests.sql`) as the body — and P7-56 made both
              of those columns rich text. So a notification about a comment
              arrived here carrying `<p>` tags and rendered them as visible
              characters.

              Flattened rather than rendered as HTML: this is a two-line summary
              inside a table row, and a `<ul>` laid out here would blow the row
              open. Same helper the emails use, and it fixes the rows already
              stored — a migration could only fix the next ones.
            */}
            {richTextToPlainText(item.body) ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{richTextToPlainText(item.body)}</p>
            ) : null}
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
      /* What the server orders by when the URL says nothing. Display only — it
         puts the arrow on the right column instead of leaving every header
         neutral, and it is the same pair `page.tsx` builds its query from. */
      defaultSort={{ key: "when", dir: "desc" }}
      empty={empty}
    />
  );
}

/**
 * The title of a notification that links nowhere — clickable only while unread.
 *
 * `variant="link"` and the padding stripped, so it reads as the title it is
 * rather than as a control bolted beside one. It is the same words in the same
 * place either way; the only difference is whether pressing them does anything.
 */
function MarkReadTitle({ item }: { item: Notification }) {
  const [pending, startTransition] = useTransition();

  if (item.read_at) {
    return <span className="text-sm">{item.title}</span>;
  }

  return (
    <Button
      variant="link"
      loading={pending}
      className="h-auto justify-start p-0 text-left text-sm font-medium whitespace-normal"
      onClick={() => startTransition(async () => markNotificationRead(item.id))}
    >
      {item.title}
      <span className="sr-only"> (unread — press to mark read)</span>
    </Button>
  );
}

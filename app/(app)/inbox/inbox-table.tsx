"use client";

import Link from "next/link";
import { CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useOptimistic } from "react";

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

/**
 * P11-05 — "Mark all read", as a client control rather than a bare server form.
 *
 * ⚠️ IT LIVES IN HERE BECAUSE ONE OPTIMISTIC VALUE HAS TO COVER BOTH THE BUTTON
 * AND EVERY ROW. It used to be a `<form action={markAllRead}>` in the page — a
 * server component, a sibling of this table, with no state either could share.
 * Optimism there would have hidden the button while forty rows stayed bold,
 * which is the half-update that reads worse than no update at all.
 */
export function InboxTable({
  rows,
  empty,
  toolbar,
  count,
  markAllAction,
}: {
  rows: Notification[];
  /**
   * P11-05 — "Mark all read", moved in here from the page.
   *
   * ⚠️ IT HAD TO MOVE, because ONE optimistic value has to cover the button AND
   * every row. It was a `<form action={markAllRead}>` in the page — a server
   * component, a sibling of this table, with no state either could share. An
   * optimistic hide there would have taken the button away while forty rows
   * stayed bold, which is the half-update that reads worse than none.
   *
   * Absent while a search is active: marking all read would silently clear rows
   * the person cannot see, so the page passes nothing and no control renders.
   */
  markAllAction?: () => Promise<void>;
  empty: React.ReactNode;
  /** Search and filters, for the table's own header strip. */
  toolbar?: React.ReactNode;
  count?: React.ReactNode;
}) {
  /* The one flag. Every `read_at` read below goes through `isRead`. */
  const router = useRouter();
  const [allRead, markAllRead] = useOptimistic(false);
  const isRead = (item: Notification) => allRead || Boolean(item.read_at);

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
            className={cn("mt-1.75 size-1.5 shrink-0 rounded-full", isRead(item) ? "bg-transparent" : "bg-primary")}
          />
          <div className="min-w-0">
            {item.link_path ? (
              // Every notification links to the exact record, never to a
              // dashboard the recipient then has to search (docs/12 §3).
              <Link
                href={item.link_path}
                className={cn("text-sm hover:underline", !isRead(item) && "font-medium")}
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
                  if (!isRead(item)) void markNotificationRead(item.id);
                }}
              >
                {item.title}
                {!isRead(item) ? <span className="sr-only"> (unread)</span> : null}
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
              <MarkReadTitle item={item} allRead={allRead} />
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
        isRead(item) ? (
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
      toolbar={
        <>
          {toolbar}
          {markAllAction && !allRead ? (
            <form
              className="ml-auto"
              action={() =>
                startTransition(async () => {
                  markAllRead(true);
                  await markAllAction();
                  /* Holds the transition until the fresh rows land; without it
                     the optimistic flag reverts and every row goes bold again
                     for a beat. */
                  router.refresh();
                })
              }
            >
              <Button type="submit" size="sm">
                <CheckCheck />
                Mark all read
              </Button>
            </form>
          ) : null}
        </>
      }
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
function MarkReadTitle({ item, allRead }: { item: Notification; allRead: boolean }) {
  /*
   * P11-05 — the row stops being unread on the click.
   *
   * Marking read is the most-pressed thing on this page and the only feedback
   * was a spinner on the title, which is the text you are trying to read. The
   * optimistic value flips the control out of existence: once read, the title is
   * a plain span, so the button that was just pressed becomes the thing it
   * pressed toward.
   */
  /* Its own optimism for a single click, plus the table's for "mark all" —
     either one is enough to turn this into a plain title. */
  const router = useRouter();
  const [read, markRead] = useOptimistic(Boolean(item.read_at));

  if (allRead) return <span className="text-sm">{item.title}</span>;

  if (read) {
    return <span className="text-sm">{item.title}</span>;
  }

  return (
    /* ⚠️ ASYNC AND AWAITED. `void`-ing the call left a SYNCHRONOUS transition
       that ended immediately, so the optimistic "read" was dropped a frame
       later and the row only changed when the server payload arrived. See
       `app/(app)/tasks/transition.tsx` for the full account — the symptom is a
       toast landing before the screen moves. */
    <form
      action={() =>
        startTransition(async () => {
          markRead(true);
          await markNotificationRead(item.id);
          router.refresh();
        })
      }
    >
      <Button
        type="submit"
        variant="link"
        className="h-auto justify-start p-0 text-left text-sm font-medium whitespace-normal"
      >
        {item.title}
        <span className="sr-only"> (unread — press to mark read)</span>
      </Button>
    </form>
  );
}

"use client";

import Link from "next/link";
import { CheckCheck } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { DataTable, type Column } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useColumnVisibility } from "@/components/data-table-columns";
import { formatDateTime } from "@/lib/dates";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/notifications";
import { qk } from "@/lib/query/keys";
import { fromAction } from "@/lib/query/mutate";
import { beginWrite, cancelRefetches, rollbackWrite } from "@/lib/query/write-cache";
import type { InboxPage } from "@/lib/query/fetchers/inbox";
import type { NotificationRow } from "@/lib/schemas/inbox";
import { richTextToPlainText } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

import { markAllNotificationsRead, markNotificationRead } from "./actions";

/**
 * P7-64 / P12-17 — the columns and the two writes.
 *
 * `cell` is a function and a function cannot cross the RSC boundary, which is
 * why this file exists at all. `inbox-view.tsx` owns the queries, the filters
 * and the paginator; this knows how to draw a row and how to mark one read.
 *
 * ⚠️ `urlSort` IS SET, AND ON THIS PAGE IT IS LOAD-BEARING. The inbox renders
 * one `.range()` of a much longer list, so sorting in the browser would reorder
 * 25 rows and present it as an ordering of all of them.
 *
 * ------------------------------------------------------------------------
 * ⚠️ BOTH `useOptimistic`S ARE GONE AND ONE MECHANISM REPLACED THEM.
 *
 * There were two — `allRead` for the button and `readIds` for the rows — plus a
 * third that had already been hoisted out of `MarkReadTitle` because a title
 * turning plain while the dot beside it stayed blue is one field rendered as two
 * pieces of state. All three were the same problem: `useOptimistic` drops its
 * value when its transition ends, so every one of them had to be set inside a
 * `startTransition` that then AWAITED the action and a `router.refresh()` —
 * a full server re-render of the route and the layout to change one `read_at`.
 *
 * The cached rows carry the prediction now. Patching `read_at` moves the dot,
 * the weight of the title, the `sr-only` "(unread)", the Read column and the
 * button's own visibility, because every one of them reads the same field off
 * the same row. Nothing reverts, because nothing about it is scoped to a
 * transition.
 *
 * ⚠️ AND `onError` IS REAL CODE NOW. React used to put the row back for free.
 * `rollbackWrite` restores the snapshot; without it a refused write would leave
 * a row looking read that the database still calls unread, and the badge in the
 * rail would disagree with the page it links to.
 * ------------------------------------------------------------------------
 */

/** The row this table draws. The contract's, parsed on arrival. */
export type Notification = NotificationRow;

/** The Server Actions, as promises TanStack can drive `onError` off. */
const readOne = fromAction(markNotificationRead);
const readAll = fromAction(markAllNotificationsRead);

/**
 * ⚠️ TWO ROOTS, AND THE SECOND IS THE ONE THAT IS EASY TO MISS. `["inbox"]` is
 * every page and filter combination of the list; `qk.unread()` is the count in
 * the header strip, which is a DIFFERENT root and cannot be prefix-matched by
 * the first however long you stare at the pair. A read receipt moves both, so a
 * rollback has to restore both — otherwise a refused write leaves the row bold
 * again beside a count that has already come down.
 */
const INBOX_ROOTS = [["inbox"], qk.unread()] as const;

/**
 * Mark rows read across EVERY cached page of the inbox.
 *
 * ⚠️ `setQueriesData` OVER THE PREFIX, NOT `setQueryData` ON ONE KEY, and the
 * reason is that this tab can hold several: page 1 unfiltered, page 1 filtered
 * to unread, the entry from before somebody typed in the search box. The row
 * just clicked can be in more than one of them, and patching only the entry the
 * click came from would leave it bold everywhere else — visible the moment
 * anybody pressed Back.
 *
 * ⚠️ AN UNCHANGED ENTRY IS RETURNED BY REFERENCE. `setQueryData` notifies its
 * observers whenever the value is not identical, so rebuilding an entry that did
 * not contain the row would re-render a table for nothing.
 *
 * `matches` picks the rows: one id, or every unread row for "mark all". Rows
 * that are ALREADY read are skipped either way, which mirrors the action — both
 * writes end in `.is("read_at", null)`, so re-stamping a row read last week is
 * something neither layer does.
 */
function patchRead(client: QueryClient, matches: (row: Notification) => boolean): void {
  const readAt = new Date().toISOString();
  let marked = 0;

  client.setQueriesData<InboxPage>({ queryKey: ["inbox"] }, (current) => {
    if (!current) return current;
    let touched = false;
    const rows = current.rows.map((row) => {
      if (row.read_at !== null || !matches(row)) return row;
      touched = true;
      marked += 1;
      return { ...row, read_at: readAt };
    });
    return touched ? { ...current, rows } : current;
  });

  /*
   * ⚠️ THE COUNT IS DECREMENTED, NOT RECOMPUTED FROM THE ROWS, and that is the
   * whole reason it is a separate key. `qk.unread()` counts the WHOLE inbox;
   * the rows on screen are one `.range()` of it. Deriving the badge from them
   * would report "3 unread" meaning "3 on this page", which is the bug
   * `fetchUnreadCount` records the RSC having shipped.
   *
   * ⚠️ `marked` COUNTS ONLY WHAT WAS CACHED, so a "mark all" over an inbox with
   * unread rows on page 2 undershoots. `onSettled` refetches the real number a
   * beat later; the guess is only there so the badge does not sit still while
   * every row on screen goes plain. `undefined` is left alone — a count that has
   * not loaded must not be invented.
   */
  client.setQueryData<number>(qk.unread(), (current) =>
    current === undefined ? current : Math.max(0, current - marked),
  );
}

export function InboxTable({
  rows,
  empty,
  toolbar,
  count,
  canMarkAll,
}: {
  rows: Notification[];
  /**
   * P11-05 — whether "Mark all read" is worth offering.
   *
   * ⚠️ THE CONTROL LIVES IN HERE BECAUSE ONE PREDICTION HAS TO COVER THE BUTTON
   * AND EVERY ROW. It was a `<form action={markAllRead}>` in the page — a server
   * component, a sibling of this table, with no state either could share. An
   * optimistic hide there would have taken the button away while forty rows
   * stayed bold, which is the half-update that reads worse than none.
   *
   * ⚠️ A BOOLEAN NOW, NOT THE ACTION ITSELF. The page used to pass the action
   * down (or `undefined` to withhold it) because it was declared inline in an
   * RSC; the action is an ordinary import here, so the only thing the view has
   * to say is whether the conditions hold. Those are unchanged: there must be
   * something unread, and no search may be active — marking all read would
   * silently clear rows the person cannot see, and searching is a reading task,
   * not a triage one. `inbox-view.tsx` adds a third: not while the unread count
   * failed to load.
   */
  canMarkAll: boolean;
  empty: React.ReactNode;
  /** Search and filters, for the table's own header strip. */
  toolbar?: React.ReactNode;
  count?: React.ReactNode;
}) {
  const queryClient = useQueryClient();

  /*
   * ⚠️ ONE READ RECEIPT, AND THE ROW CHANGES ON THE CLICK.
   *
   * `useOptimistic` used to do this and had to be held open across an awaited
   * action plus `router.refresh()`; the cached row carries the value now, so it
   * survives on its own. See the file header for the full account.
   *
   * ⚠️ NOT AWAITED BY THE LINK THAT FIRES IT. App Router navigation is
   * client-side, so this request survives the page change — awaiting it would
   * put a server round trip in front of every click on this screen, for a write
   * nobody is waiting on. `mutate` (not `mutateAsync`) is what makes that
   * true here.
   */
  const markOne = useMutation({
    mutationFn: (id: string) => readOne(id),

    onMutate: (id) => {
      const snapshot = beginWrite(queryClient, INBOX_ROOTS);
      patchRead(queryClient, (row) => row.id === id);
      // Fired, not awaited, and AFTER the patch — see `cancelRefetches`.
      cancelRefetches(queryClient, INBOX_ROOTS);
      return snapshot;
    },

    onError: (error, _id, snapshot) => {
      if (snapshot) rollbackWrite(queryClient, snapshot);
      /* ⚠️ SAID OUT LOUD, WHERE IT USED TO BE SILENT. The action returned `void`
         and never looked at `error`, so a refused update left the row looking
         read forever. The rollback puts the dot back; the toast is what explains
         a row that just went bold again under somebody's cursor. */
      toast.error(error.message || "That notification could not be marked read.");
    },

    /*
     * ⚠️ NO SUCCESS TOAST, DELIBERATELY. Marking read is the most-pressed thing
     * on this page and it usually happens on the way to somewhere else — a toast
     * per click would be a toast on every navigation out of the inbox. The row
     * changing IS the feedback.
     */

    /*
     * ⚠️ FIRED, NEVER AWAITED. `["inbox"]` is every cached page of the list,
     * `qk.unread()` is the count beside the filters, and `qk.snapshot()` is the
     * rail's badge — which is a field INSIDE the sidebar snapshot since P12-01,
     * so leaving it out would let the number in the sidebar sit one higher than
     * the page it links to. `realtime.ts` names the same three for a
     * `vizserve_pms_notifications` event; keeping the two lists in step is the
     * point of naming them from one place.
     */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: qk.unread() });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
    },
  });

  /** The same write, over every unread row rather than one. */
  const markAll = useMutation({
    mutationFn: () => readAll(),

    onMutate: () => {
      const snapshot = beginWrite(queryClient, INBOX_ROOTS);
      patchRead(queryClient, () => true);
      cancelRefetches(queryClient, INBOX_ROOTS);
      return snapshot;
    },

    onError: (error, _vars, snapshot) => {
      if (snapshot) rollbackWrite(queryClient, snapshot);
      toast.error(error.message || "Those notifications could not be marked read.");
    },

    /* This one DOES toast: it is a deliberate bulk action somebody pressed a
       button for, and forty rows going plain at once is worth confirming. */
    onSuccess: () => toast.success("All read"),

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: qk.unread() });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
    },
  });

  /*
   * ⚠️ ONE READER FOR THE UNREAD FLAG, AND IT IS THE ROW ITSELF NOW. This used
   * to fold two `useOptimistic` values in — `allRead || readIds.includes(id) ||
   * Boolean(read_at)` — precisely because the prediction lived somewhere other
   * than the data. It does not any more.
   */
  const isRead = (item: Notification) => Boolean(item.read_at);

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
                  if (!isRead(item)) markOne.mutate(item.id);
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
              <MarkReadTitle
                item={item}
                read={isRead(item)}
                onRead={() => markOne.mutate(item.id)}
              />
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
          {/*
            ⚠️ THE BUTTON HIDES ITSELF, AND IT DOES SO OFF THE COUNT RATHER THAN
            OFF A FLAG IT SET. `canMarkAll` is false the moment `qk.unread()`
            reaches zero, and `onMutate` has already written that zero — so the
            control disappears on the click, exactly as the `allRead` optimistic
            flag used to make it, with nothing left to revert when the transition
            ends. The `<form>` wrapper went with it: there is no form action to
            own a transition any more, and a lone submit button in a hidden form
            is markup pretending to be one.
          */}
          {canMarkAll ? (
            <Button
              className="ml-auto"
              size="sm"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck />
              Mark all read
            </Button>
          ) : null}
        </>
      }
      count={count}
      urlSort
      /* What the query orders by when the URL says nothing. Display only — it
         puts the arrow on the right column instead of leaving every header
         neutral, and it is the same pair `DEFAULT_INBOX_SORT` in
         `lib/query/fetchers/inbox.ts` builds the `.order()` from. Change one and
         change the other or it goes back to lying about it. */
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
function MarkReadTitle({
  item,
  read,
  onRead,
}: {
  item: Notification;
  /** Decided by the table, so the dot and the title cannot disagree. */
  read: boolean;
  /** Fires the table's own mutation. See the note below on why it takes none. */
  onRead: () => void;
}) {
  /*
   * P11-05 — the row stops being unread on the click.
   *
   * Marking read is the most-pressed thing on this page and the only feedback
   * was a spinner on the title, which is the text you are trying to read. The
   * predicted value flips the control out of existence: once read, the title is
   * a plain span, so the button that was just pressed becomes the thing it
   * pressed toward.
   *
   * ⚠️ THE MUTATION IS THE TABLE'S, NOT THIS COMPONENT'S, and that is the same
   * rule the `read` prop already followed: the dot, the weight and the title are
   * one field rendered by two components, and a second `useMutation` down here
   * would be a second thing to patch the cache from. This used to hold its own
   * `useOptimistic` for exactly that reason and it had already been hoisted once.
   *
   * ⚠️ AND THE `<form action>` IS GONE. It existed to own a `startTransition`
   * that had to outlive an awaited action and a `router.refresh()`, because
   * `useOptimistic` drops its value when its transition ends. There is no
   * transition to hold now — a plain `onClick` is the whole control.
   */
  if (read) {
    return <span className="text-sm">{item.title}</span>;
  }

  return (
    <Button
      variant="link"
      className="h-auto justify-start p-0 text-left text-sm font-medium whitespace-normal"
      onClick={onRead}
    >
      {item.title}
      <span className="sr-only"> (unread — press to mark read)</span>
    </Button>
  );
}

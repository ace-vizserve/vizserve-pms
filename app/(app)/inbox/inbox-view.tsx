"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bell, SearchX } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { ListSearch } from "@/components/list-search";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import { TableSkeleton } from "@/components/skeletons";
import { buttonVariants } from "@/components/ui/button";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchInbox,
  fetchUnreadCount,
  isInboxSort,
  type InboxSort,
} from "@/lib/query/fetchers/inbox";
import { qk } from "@/lib/query/keys";
import { isNotificationType, isReadFilter, type ReadFilter } from "@/lib/notifications";

import { InboxFilters } from "./inbox-filters";
import { InboxTable } from "./inbox-table";

/**
 * P0-10 / P12-17 — the inbox, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was an RSC: two queries, the sort allowlist, the paging arithmetic and an
 * inline `"use server"` closure for "Mark all read", all behind ONE cache entry
 * — the route's own render. Clicking a single notification therefore re-ran the
 * page AND the layout, because `markNotificationRead` ends in
 * `revalidatePath("/inbox")` and `revalidatePath("/", "layout")` and
 * `revalidatePath` has no smaller unit than a route. The reads are two query
 * keys now (`lib/query/fetchers/inbox.ts` argues which owns which) and a read
 * receipt patches the row and the badge without refetching either.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireAuthContext()` runs in
 * `page.tsx` beside this. Nothing on this screen is a role decision — RLS scopes
 * every row to `user_id = auth.uid()` — so unlike `/tasks` there is no `viewer`
 * to compute, which is why this file takes only the URL.
 *
 * ⚠️ AND NOTHING ABOUT THE NARROWING OR THE PAGINATOR CHANGED ON THE WAY. The
 * `hrefFor` rebuild, the "defaults stay out of the URL" rule and the guards
 * against a hand-edited `?type=` are the same lines in the same order, minus the
 * `?? []`s that a throwing `read()` makes unnecessary.
 * ------------------------------------------------------------------------
 */

/**
 * The URL contract, unchanged and still the shareable source of truth.
 *
 * Read on the server, passed down as a prop, and handed to `qk.inbox` as the
 * filter half of the key. Deliberately NOT re-read here with `useSearchParams`:
 * the page already awaited them, and two readings of the same URL is how a key
 * and a query drift by one navigation.
 */
export type InboxSearchParams = {
  q?: string;
  page?: string;
  size?: string;
  type?: string;
  read?: string;
  sort?: string;
  dir?: string;
};

export function InboxView({ params }: { params: InboxSearchParams }) {
  const term = params.q?.trim() ?? "";
  // Both clamped in components/pagination.tsx. `size` in particular is not
  // decoration: .range() takes what it is given, so an unvalidated ?size=100000
  // is one URL edit away from selecting every row the caller can see.
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);

  // Narrowed rather than trusted. An unknown enum value reaches Postgres as
  // "invalid input value for enum" and surfaces as an error, where a
  // hand-edited URL should just be an ignored filter.
  const type = isNotificationType(params.type) ? params.type : null;
  const read: ReadFilter = isReadFilter(params.read) ? params.read : "all";

  /* `undefined` when the URL named no sort we recognise, and that distinction is
     load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
     collapsed into a resolved sort. `isInboxSort` and the order map live in the
     fetcher, beside the `.order()` they pick a column for. */
  const requestedSort: InboxSort | undefined = isInboxSort(params.sort) ? params.sort : undefined;

  /*
   * ⚠️ THE KEY IS BUILT FROM THE NARROWED VALUES, NOT FROM THE RAW URL, and it
   * has to be: `?type=banana` and no `?type=` at all produce the same rows, so
   * they must produce the same cache entry. `normalize()` inside `qk.inbox`
   * drops the `undefined`s; narrowing first is what makes two spellings of the
   * same filter one entry rather than two.
   */
  const rowsQuery = useQuery({
    queryKey: qk.inbox({
      q: term,
      type: type ?? undefined,
      read: read === "all" ? undefined : read,
      page: page > 1 ? String(page) : undefined,
      size: pageSize !== PAGE_SIZES[0] ? String(pageSize) : undefined,
      sort: requestedSort,
      dir: requestedSort && params.dir === "desc" ? "desc" : undefined,
    }),
    queryFn: () =>
      /*
       * ⚠️ `browserClient()` IS CALLED INSIDE THE `queryFn`, NEVER IN THIS BODY.
       * A `"use client"` component is still RENDERED ON THE SERVER for its
       * initial HTML, and `createBrowserClient` reaches for `document.cookie`.
       * A `queryFn` only ever runs in the browser.
       */
      fetchInbox(browserClient(), {
        term,
        type,
        read,
        page,
        pageSize,
        requestedSort,
        dir: params.dir,
      }),
  });

  /*
   * The unread count, on its own key and ignoring the filters.
   *
   * ⚠️ ITS OWN QUERY BECAUSE IT IS ITS OWN FACT. "12 unread" beside "4 results"
   * is two answers to two questions, and folding the count into the rows entry
   * would both refetch it on every filter change and make it a property of the
   * current PAGE — which is the bug the RSC's own comment records.
   *
   * ⚠️ AND `qk.unread()` FINALLY HAS AN OBSERVER. It has been defined since
   * P12-01 and read by nothing, because the RAIL's badge is a field inside the
   * sidebar snapshot. `realtime.ts` already invalidates this key on every
   * notification event, so a notification arriving while this page is open now
   * moves the number with no navigation.
   */
  const unreadQuery = useQuery({
    queryKey: qk.unread(),
    queryFn: () => fetchUnreadCount(browserClient()),
  });

  const isFiltered = Boolean(term) || Boolean(type) || read !== "all";

  function hrefFor(target: number) {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (type) next.set("type", type);
    if (read !== "all") next.set("read", read);
    // Defaults stay out of the URL, so the everyday link is just /inbox.
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    /* ⚠️ WITHOUT THESE TWO, PAGE 2 SILENTLY REVERTS TO THE DEFAULT ORDER.
       `hrefFor` rebuilds the query string from narrowed values rather than
       copying the incoming URL, so every param it forgets is a param the
       paginator drops. Only what the URL actually named, though — emitting the
       default back would be a link claiming a choice nobody made, and `dir`
       without a `sort` beside it now means nothing at all. */
    if (requestedSort) next.set("sort", requestedSort);
    if (requestedSort && params.dir === "desc") next.set("dir", "desc");
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/inbox?${query}` : "/inbox";
  }

  const total = rowsQuery.data?.total ?? 0;

  /*
   * ⚠️ AN UNREADABLE COUNT IS NOT A ZERO, AND THIS PAGE HAS TO SAY SO. The
   * header strip reads "All read" when the number is 0 — the single most
   * reassuring sentence on the screen — so a failed count that fell back to 0
   * would tell somebody holding twenty unread notifications that they were
   * clear. `null` is the unknown state and every reader below handles it
   * separately, the same shape `FolderCounts` in `nav-projects.tsx` took for the
   * rail's counts in P12-01.
   */
  const unreadCount = unreadQuery.isError ? null : (unreadQuery.data ?? null);

  return (
    // Full width, like the other list pages. The old max-w-3xl gave a reading
    // measure, which is right for prose and wrong here — a notification is a
    // title, a line of context and a timestamp, and constraining it just wasted
    // two thirds of a wide screen and made the list taller than it needed to be.
    <PageShell>
      {/*
        A PLAIN toolbar. This used to be sticky, and it was wrong in three ways
        at once: `top-16` was measured against an `h-16` shell header that is now
        `h-14`, so an 8px band of rows showed above it; `-mx-4 px-4` was measured
        against a `p-4` PageShell that is now `p-5`, so rows slid visibly through
        the 4px of gutter it failed to cover; and an opaque bar pinned over a
        list is the one thing the frosted app header was redesigned NOT to be.

        Pinning it also solved a problem the paginator already solves. The list
        is 25 rows, not hundreds — the filters are a short scroll away, and a
        stationary toolbar cannot go out of register with a header it does not
        touch.
      */}
      {/* ⚠️ "Mark all read" LIVES IN THE TABLE (P11-05). It has to live where
          the rows do: one optimistic value covers the button and all forty rows,
          and a button that hid itself from out here would leave them bold.

          Still absent while a search is active — marking all read would silently
          clear rows the person cannot see, so nothing is passed and no control
          renders. Searching is a reading task, not a triage one.

          ⚠️ AND `canMarkAll` IS FALSE WHILE THE COUNT IS UNKNOWN. Offering a
          bulk write off a number that could not be read is offering an action
          nobody can predict the effect of. */}
      <InboxTable
        canMarkAll={unreadCount !== null && unreadCount > 0 && !term}
        toolbar={
          <>
            <ListSearch
              initial={term}
              basePath="/inbox"
              id="inbox-search"
              placeholder="Search notifications"
              className="w-full sm:w-56 lg:w-64"
            />

            <InboxFilters type={type} read={read} />
          </>
        }
        count={
          /*
           * ⚠️ NOTHING IS CLAIMED UNTIL SOMETHING IS KNOWN. `total` is 0 while
           * the query is pending and 0 when it failed, and both would render as
           * "0 results" or — worse, on an unfiltered inbox — "All read", which
           * is the single most reassuring sentence on this screen drawn over a
           * list that has not arrived. The skeleton below is what is on screen
           * for the pending case; this strip says nothing at all until it can
           * say something true.
           */
          rowsQuery.isPending || rowsQuery.isError ? null : isFiltered ? (
            <>
              <span className="tabular-nums">{total}</span> {total === 1 ? "result" : "results"}
              {unreadCount === null ? (
                <span className="text-muted-foreground/70">
                  {" "}
                  · <span aria-hidden>—</span>
                  <span className="sr-only">unread count unavailable</span>
                </span>
              ) : unreadCount > 0 ? (
                <span className="text-muted-foreground/70"> · {unreadCount} unread</span>
              ) : null}
            </>
          ) : unreadCount === null ? (
            <>
              <span aria-hidden>—</span>
              <span className="sr-only">unread count unavailable</span>
            </>
          ) : unreadCount > 0 ? (
            `${unreadCount} unread`
          ) : (
            "All read"
          )
        }
        rows={rowsQuery.data?.rows ?? []}
        empty={
          /*
           * ⚠️ THE THREE BRANCHES ARE THE WHOLE OF P12-01 ON THIS PAGE, IN
           * ORDER: could not load, still loading, genuinely nothing. They used
           * to be one branch — the RSC did `(notifications ?? [])` and rendered
           * "Nothing yet. You will be notified here when a request needs your
           * approval" over a query that had died.
           */
          rowsQuery.isError ? (
            <QueryError what="your notifications" message={rowsQuery.error.message} />
          ) : rowsQuery.isPending ? (
            /* `isPending` is "no data yet", not "fetching" — a background
               refetch over rows we already have keeps drawing them. */
            <TableSkeleton columns={3} rows={8} />
          ) : isFiltered ? (
            <EmptyState
              icon={<SearchX />}
              title="No notifications match that"
              description={
                term
                  ? "Try a shorter term, or part of a request title. Search covers the heading and the body text."
                  : "Nothing in this inbox matches those filters. Widen the type or status to see more."
              }
              action={
                // A link, not a Button — this navigates, and Button here no
                // longer supports asChild.
                <Link href="/inbox" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              }
            />
          ) : (
            <EmptyState
              icon={<Bell />}
              title="Nothing yet"
              description="You will be notified here when a request needs your approval, or when work you are assigned to moves."
            />
          )
        }
      />

      <Pagination page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} basePath="/inbox" />
    </PageShell>
  );
}

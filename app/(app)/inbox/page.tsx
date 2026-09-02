import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";

import { Bell, CheckCheck, SearchX } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";

import {
  isNotificationType,
  isReadFilter,
  type ReadFilter,
} from "@/lib/notifications";
import { ilikeAnyOf } from "@/lib/search";
import { InboxTable, type Notification } from "./inbox-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { Button, buttonVariants } from "@/components/ui/button";
import { ListSearch } from "@/components/list-search";
import { InboxFilters } from "./inbox-filters";

export const metadata: Metadata = { title: "Inbox" };

/**
 * P0-10 — the inbox.
 *
 * "One place to look" (docs/12 §3): every emailed event also writes a row here,
 * so email is a nudge toward the inbox rather than a separate truth. Anything
 * that does NOT email still lands here — that is the whole point of the split.
 *
 * RLS restricts rows to `user_id = auth.uid()`, so these queries carry no filter
 * and cannot leak someone else's notifications by omission.
 *
 * Paged and searchable server-side. It used to fetch a flat 100 and render all
 * of them, which was fine on day one and is not once a member has a few months
 * of task movement behind them.
 *
 * The nav unread badge was deferred at P0-10 (Amier, 21:20) and is now built —
 * see components/app-shell/app-sidebar.tsx.
 */

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    size?: string;
    type?: string;
    read?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const term = params.q?.trim() ?? "";
  // Both clamped in components/pagination.tsx. `size` in particular is not
  // decoration: .range() takes what it is given, so an unvalidated ?size=100000
  // is one URL edit away from selecting every row the caller can see.
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);

  // Narrowed rather than trusted. An unknown enum value reaches Postgres as
  // "invalid input value for enum" and surfaces as an error page, where a
  // hand-edited URL should just be an ignored filter.
  const type = isNotificationType(params.type) ? params.type : null;
  const read: ReadFilter = isReadFilter(params.read) ? params.read : "all";

  /*
   * P7-64 — THE SORT ALLOWLIST. `?sort=` is a string somebody can type, so it
   * is narrowed to a closed union and used to PICK a literal column name. It is
   * never interpolated into `.order()`.
   */
  const SORTS = ["when", "type", "read", "emailed"] as const;
  type Sort = (typeof SORTS)[number];
  const sort: Sort = (SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as Sort)
    : "when";
  const NOTIFICATION_ORDER: Record<Sort, string> = {
    when: "created_at",
    type: "type",
    read: "read_at",
    emailed: "emailed_at",
  };
  // Newest first is the inbox's whole point, so "when" defaults to descending.
  const ascending = params.dir ? params.dir !== "desc" : sort !== "when";

  const from = (page - 1) * pageSize;

  let query = supabase
    .from("vizserve_pms_notifications")
    .select("id, type, title, body, link_path, read_at, created_at, send_email, emailed_at", {
      count: "exact",
    })
    .order(NOTIFICATION_ORDER[sort], { ascending })
    .range(from, from + pageSize - 1);

  // Escaped in lib/search.ts — `.or()` takes a raw filter string, so a comma or
  // a quote typed into the search box would otherwise corrupt the expression.
  const searchFilter = ilikeAnyOf(["title", "body"], term);
  if (searchFilter) query = query.or(searchFilter);

  if (type) query = query.eq("type", type);
  // `.not("read_at", "is", null)` rather than `.neq`: SQL null is not equal to
  // anything, including itself, so neq would return zero rows for every row.
  if (read === "unread") query = query.is("read_at", null);
  if (read === "read") query = query.not("read_at", "is", null);

  const [{ data: notifications, count }, unread] = await Promise.all([
    query,
    // Counted separately, and this is not optional. It used to be derived from
    // the fetched rows, which was correct only while the page held everything —
    // with paging that would report "3 unread" meaning "3 on this page".
    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
  ]);

  const total = count ?? 0;
  const unreadCount = unread.count ?? 0;
  const rows = (notifications ?? []) as Notification[];
  const isFiltered = Boolean(term) || Boolean(type) || read !== "all";

  async function markAllRead() {
    "use server";
    await requireAuthContext();
    const client = await createClient();
    // No `.eq("user_id", …)`: RLS already scopes the update to the caller's own
    // rows, and restating it here would imply the policy is optional.
    //
    // Deliberately NOT limited to the current page or the current search. The
    // button says "all", and a Mark-all-read that leaves unread rows behind the
    // paginator is the kind of thing people stop trusting.
    await client
      .from("vizserve_pms_notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    revalidatePath("/inbox");
  }

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
       paginator drops. */
    if (sort !== "when") next.set("sort", sort);
    if (params.dir === "desc" || (sort !== "when" && params.dir === "desc")) next.set("dir", "desc");
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/inbox?${query}` : "/inbox";
  }

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
      <InboxTable
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

            {/* Marking all read while a search is active would silently clear
                rows the person cannot see, so the control goes away — searching
                is a reading task, not a triage one. */}
            {unreadCount > 0 && !term ? (
              <form action={markAllRead}>
                <Button type="submit" variant="outline" size="sm">
                  <CheckCheck />
                  Mark all read
                </Button>
              </form>
            ) : null}
          </>
        }
        count={
          isFiltered ? (
            <>
              <span className="tabular-nums">{total}</span> {total === 1 ? "result" : "results"}
              {unreadCount > 0 ? (
                <span className="text-muted-foreground/70"> · {unreadCount} unread</span>
              ) : null}
            </>
          ) : unreadCount > 0 ? (
            `${unreadCount} unread`
          ) : (
            "All read"
          )
        }
        rows={rows}
        empty={
          isFiltered ? (
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

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={hrefFor}
        basePath="/inbox"
      />
    </PageShell>
  );
}

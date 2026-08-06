import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";

import { Bell, CheckCheck, SearchX } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { formatDateTime } from "@/lib/dates";
import { isNotificationType, isReadFilter, type ReadFilter } from "@/lib/notifications";
import { ilikeAnyOf } from "@/lib/search";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { Button, buttonVariants } from "@/components/ui/button";
import { InboxFilters } from "./inbox-filters";
import { InboxSearch } from "./inbox-search";

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

  const from = (page - 1) * pageSize;

  let query = supabase
    .from("vizserve_pms_notifications")
    .select("id, type, title, body, link_path, read_at, created_at, send_email, emailed_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
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
  const rows = notifications ?? [];
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
      {/* One row: search, then the two filters, then Mark all read at the far
          end. `items-end` is what lines the unlabelled search box up with the
          labelled selects — aligning on centre leaves the search sitting a few
          pixels high, which is exactly the sort of thing that reads as sloppy
          without anyone being able to say why. */}
      <div className="flex flex-wrap items-end gap-3">
        <InboxSearch initial={term} className="w-full sm:w-64 lg:w-72" />

        <InboxFilters type={type} read={read} />

        {/* Marking all read while a search is active would silently clear rows
            the person cannot see, so the control goes away — searching is a
            reading task, not a triage one. */}
        {unreadCount > 0 && !term ? (
          <form action={markAllRead} className="ml-auto">
            {/* Default size, not sm. Input, SelectTrigger and Button all sit at
                h-8 on `default`; `sm` is h-7, and mixing the two is what left
                this row four pixels out of alignment. */}
            <Button type="submit" variant="outline">
              <CheckCheck />
              Mark all read
            </Button>
          </form>
        ) : null}
      </div>

      {/* When anything is narrowing the list, the count has to describe the
          RESULTS. Showing "1609 unread" above nine filtered rows is the kind of
          mismatch that makes people distrust both numbers. */}
      <p className="text-xs text-muted-foreground">
        {isFiltered ? (
          <>
            <span className="tabular-nums">{total}</span> {total === 1 ? "result" : "results"}
            {term ? <> for &ldquo;{term}&rdquo;</> : null}
            {unreadCount > 0 ? (
              <span className="text-muted-foreground/70"> · {unreadCount} unread in total</span>
            ) : null}
          </>
        ) : unreadCount > 0 ? (
          `${unreadCount} unread`
        ) : (
          "All read"
        )}
      </p>

      {rows.length === 0 ? (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {isFiltered ? (
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
          )}
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {rows.map((item) => {
            const content = (
              <div className="flex items-start gap-3 p-4">
                <span
                  aria-hidden
                  className={
                    item.read_at
                      ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-transparent"
                      : "mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className={item.read_at ? "text-sm" : "text-sm font-medium"}>
                    {item.title}
                    {/* Unread is stated, not just dotted — a colour dot alone is
                        not an accessible status. */}
                    {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
                  </p>
                  {item.body ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                  ) : null}
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {formatDateTime(item.created_at)}
                    {item.emailed_at ? " · emailed" : null}
                  </p>
                </div>
              </div>
            );

            return (
              <li key={item.id} className={item.read_at ? "" : "bg-muted/30"}>
                {/* Every notification links to the exact record, never to a
                    dashboard the recipient then has to search (docs/12 §3). */}
                {item.link_path ? (
                  <Link href={item.link_path} className="block hover:bg-muted/50">
                    {content}
                  </Link>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ul>
      )}

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

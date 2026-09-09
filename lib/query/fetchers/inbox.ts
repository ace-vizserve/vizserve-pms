import type { VizservePmsNotificationType } from "@/lib/database.types";
import type { ReadFilter } from "@/lib/notifications";
import { parseAll } from "@/lib/query/parse";
import { read, readCount } from "@/lib/query/read";
import { ilikeAnyOf } from "@/lib/search";
import { notificationRowSchema, type NotificationRow } from "@/lib/schemas/inbox";

import type { TaskReadClient } from "./task";

/**
 * P12-17 — the reads behind `/inbox` and its unread badge.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `page.tsx` was an RSC holding the sort allowlist, the
 * paging arithmetic, the search escaping, two queries and a `revalidatePath`.
 * Marking one notification read re-ran the whole route AND the layout, because
 * the action called `revalidatePath("/inbox")` and `revalidatePath("/", "layout")`
 * — a full server render of the shell to change one row's `read_at`.
 *
 * ⚠️ TWO KEYS, NOT ONE, AND THE SPLIT IS THE POINT. `qk.inbox(filters)` is a
 * PAGE of rows under a search and a sort; `qk.unread()` is a count over the
 * whole table. Folding the count into the rows entry would make every filter
 * change refetch it, and — worse — would make it a property of the current page:
 * the RSC's own comment records that the count "used to be derived from the
 * fetched rows, which was correct only while the page held everything", so with
 * paging it reported "3 unread" meaning "3 on this page". Splitting them is also
 * what lets a read receipt patch the badge without refetching the list.
 *
 * ⚠️ `qk.unread()` GETS ITS FIRST REAL CONSUMER HERE. It has been defined since
 * P12-01 and read by nothing — the RAIL's badge is a field inside the sidebar
 * snapshot, which is why `realtime.ts` lists `qk.snapshot()` on the
 * notifications row. This page needs a count that is not the rail's, because it
 * renders it beside the results total, so the key finally has an observer.
 * `realtime.ts` already invalidates it; nothing there changes.
 *
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER. `notifications select own` is
 * `user_id = auth.uid()`, so neither query carries a `.eq("user_id", …)` and
 * neither can leak somebody else's inbox by omission. The RSC said the same.
 *
 * ⚠️ AND BOTH GO THROUGH `read()`/`readCount()`, WHICH THROW. The page used to
 * end in `(notifications ?? [])` and `unread.count ?? 0`, so a failed query
 * rendered as "Nothing yet — you will be notified here when a request needs your
 * approval". That is a reassuring sentence drawn over an unreadable inbox, and
 * it is the exact class of bug this whole phase set out to remove.
 * ------------------------------------------------------------------------
 */

/**
 * P7-64 — THE SORT ALLOWLIST, MOVED OUT OF THE PAGE.
 *
 * `?sort=` is a string somebody can type, so it is narrowed to a closed union
 * and used to PICK a literal column name below. It is never interpolated into
 * `.order()` — an unknown column reaches Postgres as `invalid input value` and
 * takes the page down, which is why every `.order()` in this repo names its
 * column outright.
 */
export const INBOX_SORTS = ["when", "type", "read", "emailed"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export function isInboxSort(value: string | undefined): value is InboxSort {
  return typeof value === "string" && (INBOX_SORTS as readonly string[]).includes(value);
}

/**
 * The order applied when the URL asks for none. Newest first is the inbox's
 * whole point.
 *
 * `inbox-table.tsx` passes the same pair to `DataTable` as `defaultSort`, which
 * is the only reason its header can draw an arrow for an order nobody put in the
 * query string — change one and change the other or it goes back to lying about
 * it.
 */
export const DEFAULT_INBOX_SORT = { sort: "when", ascending: false } as const;

const ORDER_COLUMN: Record<InboxSort, string> = {
  when: "created_at",
  type: "type",
  read: "read_at",
  emailed: "emailed_at",
};

export type InboxParams = {
  term: string;
  type: VizservePmsNotificationType | null;
  read: ReadFilter;
  page: number;
  pageSize: number;
  /**
   * `undefined` when the URL named no sort we recognise, and that distinction is
   * load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
   * collapsed into a resolved sort.
   */
  requestedSort: InboxSort | undefined;
  dir: string | undefined;
};

export type InboxPage = {
  rows: NotificationRow[];
  /** Rows matching the filters, across every page. Drives the paginator. */
  total: number;
};

/** `qk.inbox(filters)` — one `.range()` of the caller's own notifications. */
export async function fetchInbox(
  client: TaskReadClient,
  params: InboxParams,
): Promise<InboxPage> {
  const sort: InboxSort = params.requestedSort ?? DEFAULT_INBOX_SORT.sort;
  /*
   * ONE SOURCE FOR THE DIRECTION. An explicit sort obeys `?dir=` — ascending
   * unless it says otherwise, which is why the table leaves `asc` out of the URL
   * — and no explicit sort takes the default's. Reading a column name back out
   * of the URL to decide the direction, as this once did, meant the arrow and
   * the rows could disagree and "When" could never be sorted oldest-first.
   */
  const ascending = params.requestedSort ? params.dir !== "desc" : DEFAULT_INBOX_SORT.ascending;

  const from = (params.page - 1) * params.pageSize;

  let query = client
    .from("vizserve_pms_notifications")
    .select("id, type, title, body, link_path, read_at, created_at, send_email, emailed_at", {
      count: "exact",
    })
    .order(ORDER_COLUMN[sort], { ascending })
    .range(from, from + params.pageSize - 1);

  // Escaped in lib/search.ts — `.or()` takes a raw filter string, so a comma or
  // a quote typed into the search box would otherwise corrupt the expression.
  const searchFilter = ilikeAnyOf(["title", "body"], params.term);
  if (searchFilter) query = query.or(searchFilter);

  if (params.type) query = query.eq("type", params.type);
  // `.not("read_at", "is", null)` rather than `.neq`: SQL null is not equal to
  // anything, including itself, so neq would return zero rows for every row.
  if (params.read === "unread") query = query.is("read_at", null);
  if (params.read === "read") query = query.not("read_at", "is", null);

  /*
   * ⚠️ ONE AWAIT, TWO ANSWERS, AND THE COUNT CANNOT GO THROUGH `readCount()`.
   *
   * This is a `select` with `count: "exact"`, so it returns BOTH `data` and
   * `count` from one round trip. `readCount()` is for `head: true` queries,
   * where `data` is null on success and `?? 0` would be indistinguishable from a
   * failure — that is `fetchUnreadCount` below. Destructuring both here would
   * mean either running the query twice or reaching past `read()`, so the
   * builder is awaited once and its error is raised the same way.
   */
  const { data, count, error } = await query;
  if (error) {
    // Re-thrown through `read()` so the message and the PostgREST code are
    // shaped exactly like every other failed read in the app — `isPermanent()`
    // keys on that code to decide whether retrying is worth anything.
    await read<unknown>(Promise.resolve({ data: null, error }));
  }

  return {
    rows: parseAll(notificationRowSchema, data ?? [], "notifications"),
    total: count ?? 0,
  };
}

/**
 * `qk.unread()` — how many of the caller's notifications are unread, in total.
 *
 * ⚠️ COUNTED SEPARATELY FROM THE ROWS, AND THIS IS NOT OPTIONAL. The RSC's own
 * comment: it "used to be derived from the fetched rows, which was correct only
 * while the page held everything — with paging that would report '3 unread'
 * meaning '3 on this page'".
 *
 * ⚠️ AND IT IGNORES THE FILTERS ON PURPOSE. "12 unread" beside "4 results" is
 * two different facts and both are wanted: the second describes what is on
 * screen, the first describes the inbox. It is also what "Mark all read"
 * operates on — the button says "all", and one that left unread rows behind the
 * paginator is the kind of thing people stop trusting.
 */
export async function fetchUnreadCount(client: TaskReadClient): Promise<number> {
  return readCount(
    client
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
  );
}

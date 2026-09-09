"use client";

import { useQuery } from "@tanstack/react-query";

import { ListSearch } from "@/components/list-search";
import { PageShell } from "@/components/page-shell";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { isRequestStatus } from "@/components/status-badge";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchClientForms,
  fetchRequestsPage,
  isRequestSort,
  type RequestSort,
} from "@/lib/query/fetchers/requests";
import { qk } from "@/lib/query/keys";

import { RequestFilters } from "./filters";
import { RequestsTable } from "./requests-table";

/**
 * P1-13 / P12-18 — the Team Leader's queue and Gate 1's front door, reading
 * from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was an RSC holding two queries, then a third keyed by the reviewers on
 * the page it had just fetched, plus the sort allowlist, the paging arithmetic
 * and the search escaping — all behind ONE cache entry, the route's own render.
 * Approving at Gate 1 called `revalidatePath` on this route, on
 * `/requests/[id]`, on `/` and on `/dashboard`, so one decision re-ran every one
 * of them. The reads are two query keys now and a decision invalidates the
 * `["requests"]` prefix.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireRole("team_leader")` runs
 * in `page.tsx` beside this, and so does `realtimeDepartmentFilter(context)` —
 * `lib/auth/authorization.ts` is `server-only`, deliberately, and a client
 * component deciding its own subscription scope is exactly the rule CLAUDE.md
 * forbids. Department scoping of the ROWS is RLS's job either way, which is what
 * makes the Phase 1 exit criterion — "a request appears in the correct TL's
 * queue and nowhere else" — assertable at the API layer rather than by clicking
 * around.
 *
 * ⚠️ AND THE REALTIME DOORBELL IS UNMUTED BY THIS FILE EXISTING. `<RealtimeTasks>`
 * has been mounted on this page since P8-03 and P12-02 muted it for the TABLE:
 * the ping invalidates `qk.tasks()` and `qk.snapshot()`, the rail's
 * awaiting-review count moved live, and the rows waited for a navigation because
 * they were server-rendered. `qk.requests(f)` is observed now, so
 * `lib/query/realtime.ts`'s existing `vizserve_pms_requests: [["requests"], …]`
 * row — and the task-INSERT that a Gate 1 approval produces — reach these rows
 * with no change to either file. The honest gap the page recorded is unchanged:
 * a second lead RETURNING or REJECTING writes no task and publishes nothing, so
 * that still corrects on the next navigation.
 * ------------------------------------------------------------------------
 */

/**
 * The URL contract, unchanged and still the shareable source of truth.
 *
 * Read on the server, passed down as a prop, and handed to `qk.requests` as the
 * filter half of the key. Deliberately NOT re-read here with `useSearchParams`:
 * the page already awaited them, and two readings of the same URL is how a key
 * and a query drift by one navigation.
 */
export type RequestsSearchParams = {
  status?: string;
  form?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  q?: string;
  page?: string;
  size?: string;
};

export function RequestsView({
  params,
  realtimeFilter,
}: {
  params: RequestsSearchParams;
  /** `realtimeDepartmentFilter(context)`, computed on the server. See `page.tsx`. */
  realtimeFilter: string | null;
}) {
  const term = (params.q ?? "").trim();
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);

  // Narrowed rather than trusted. An unknown enum value reaches Postgres as
  // "invalid input value" and 500s the query, where a hand-edited URL should
  // just be an ignored filter.
  const status = isRequestStatus(params.status) ? params.status : null;
  const requestedSort: RequestSort | undefined = isRequestSort(params.sort)
    ? params.sort
    : undefined;

  /*
   * ⚠️ THE KEY IS BUILT FROM THE NARROWED VALUES, NOT FROM THE RAW URL, and it
   * has to be: `?status=banana` and no `?status=` at all produce the same rows,
   * so they must produce the same cache entry. `normalize()` inside
   * `qk.requests` drops the `undefined`s; narrowing first is what makes two
   * spellings of one filter one entry rather than two.
   */
  const rowsQuery = useQuery({
    queryKey: qk.requests({
      q: term,
      status: status ?? undefined,
      form: params.form,
      from: params.from,
      to: params.to,
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
       */
      fetchRequestsPage(browserClient(), {
        term,
        status,
        formId: params.form ?? null,
        from: params.from ?? null,
        to: params.to ?? null,
        page,
        pageSize,
        requestedSort,
        dir: params.dir,
      }),
  });

  /*
   * The form list: the filter dropdown's options AND the SLA column's target.
   *
   * ⚠️ REFERENCE DATA, SO IT SURVIVES A FILTER CHANGE. In the RSC it was a
   * sibling of the rows query and re-ran with them on every navigation — two
   * round trips to answer two unrelated questions, one of which cannot have
   * changed. Under `qk.ref("client-forms")` it carries `REF_STALE_TIME` and the
   * dropdown simply stays populated while the rows come and go.
   */
  const formsQuery = useQuery({
    queryKey: qk.ref("client-forms"),
    queryFn: () => fetchClientForms(browserClient()),
  });

  const forms = formsQuery.data ?? [];
  const formNames = Object.fromEntries(forms.map((form) => [form.id, form.name]));
  const formSlaMinutes = Object.fromEntries(forms.map((form) => [form.id, form.sla_minutes]));

  const isFiltered = Boolean(status || params.form || params.from || params.to || term);
  const total = rowsQuery.data?.total ?? 0;

  /*
   * ⚠️ REBUILT FROM THE NARROWED VALUES, NOT COPIED FROM THE URL — the same
   * shape `/inbox` and `/admin/audit` use. Every param this forgets is a param
   * the paginator silently drops, which is why `sort` and `dir` are here.
   */
  function hrefFor(target: number) {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (status) next.set("status", status);
    if (params.form) next.set("form", params.form);
    if (params.from) next.set("from", params.from);
    if (params.to) next.set("to", params.to);
    /* Only what the URL actually named. Emitting the default back would be a
       link claiming a choice nobody made, and `dir` without a `sort` beside it
       now means nothing at all. */
    if (requestedSort) next.set("sort", requestedSort);
    if (requestedSort && params.dir === "desc") next.set("dir", "desc");
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/requests?${query}` : "/requests";
  }

  return (
    <PageShell>
      {/*
        P8-03 — ⚠️ A TASK SUBSCRIPTION ON THE REQUESTS PAGE. THIS IS NOT A
        COPY-PASTE MISTAKE.

        `vizserve_pms_requests` is deliberately NOT published to Realtime,
        and the reason is one missing column: a request has no
        `department_id`, only a `form_id`. A Postgres Changes `filter` is a
        single `column=operator.value` on the changed table and cannot
        join, so there is no way to scope a request stream to a department
        — publishing it would put every request event in the company on a
        stream bounded only by RLS, which is the firehose this design
        exists to avoid.

        THIS QUEUE GOES LIVE ANYWAY BECAUSE APPROVING AT GATE 1 CREATES A
        TASK. `vizserve_pms_approve_request` inserts into
        `vizserve_pms_tasks` in the request's department, and that INSERT
        is an event the filtered task stream already carries — the task
        channel is only the doorbell.

        ⚠️ P12-02 MUTED THAT DOORBELL FOR THIS PAGE AND P12-18 GAVE IT BACK.
        The ping used to `router.refresh()`, which re-ran a server component
        so the request rows came back fresh through their own RLS; P12-02
        swapped it for invalidation, and for one phase only the RAIL had an
        observer because these rows were still server-rendered. They read
        from `qk.requests(f)` now, `["requests"]` prefix-matches it, and a
        COLLEAGUE's approval repaints this queue again with no navigation.

        ⚠️ THE HONEST GAP, UNCHANGED: a second Team Leader RETURNING or
        REJECTING a request writes no task, so nothing is published and this
        page will not push for it. It corrects on the next navigation, which
        is what it did before P8-03 — a place that phase did not reach, not a
        regression. Closing it means adding a NOTIFICATION on those two
        transitions (that table is published and is filtered to the
        recipient), never widening this stream.
      */}
      <RealtimeTasks filter={realtimeFilter} />

      <RequestsTable
        toolbar={
          <>
            <ListSearch
              initial={term}
              basePath="/requests"
              id="requests-search"
              placeholder="Search reference, title or requester"
              className="w-full sm:w-56 lg:w-64"
            />

            <RequestFilters forms={forms} />
          </>
        }
        /* The readout describes the RESULTS, beside the filters that produced
           them — a total that ignores the filters above it is the kind of
           mismatch that makes people distrust both numbers.

           ⚠️ NOTHING IS CLAIMED UNTIL SOMETHING IS KNOWN. `total` is 0 while the
           query is pending and 0 when it failed, and "0 requests in total" over
           an unread queue is the wrong zero this whole phase is about. */
        count={
          rowsQuery.isPending || rowsQuery.isError ? null : (
            <>
              <span className="tabular-nums">{total}</span> {total === 1 ? "request" : "requests"}
              {isFiltered ? " matching" : " in total"}
            </>
          )
        }
        rows={rowsQuery.data?.rows ?? []}
        formNames={formNames}
        formSlaMinutes={formSlaMinutes}
        reviewerNames={rowsQuery.data?.reviewerNames ?? {}}
        isFiltered={isFiltered}
        isPending={rowsQuery.isPending}
        errorMessage={rowsQuery.isError ? rowsQuery.error.message : undefined}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={hrefFor}
        basePath="/requests"
      />
    </PageShell>
  );
}

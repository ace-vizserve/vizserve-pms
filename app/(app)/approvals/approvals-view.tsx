"use client";

import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import { TableSkeleton } from "@/components/skeletons";
import { todayInAppZone } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import {
  APPROVALS_PAGE_SIZE,
  fetchApprovalsQueue,
  fetchFilingOptions,
  isApprovalSort,
  type ApprovalSort,
} from "@/lib/query/fetchers/approvals";
import { qk } from "@/lib/query/keys";
import { currentBalanceYear } from "@/lib/schemas/leave-balances";
import { narrowRequestPrefill } from "@/lib/schemas/internal-requests";
import type { ApprovalsViewer } from "@/lib/schemas/internal-approvals";

import { MyLeaveRecordButton } from "./my-leave-record";
import { NewRequestDialog } from "./new-request-dialog";
import { Section } from "./approvals-table";
import { TimesheetWeeksSection } from "./timesheet-weeks-table";

/**
 * P5-10 / P12-19 — my requests, and requests pending my approval, reading from
 * the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was an RSC awaiting EIGHT queries in one wave and then a ninth keyed by
 * the reviewers it had just fetched — all behind ONE cache entry, the route's
 * own render. Deciding anything called `revalidatePath` on `/approvals`, `/`,
 * `/dashboard`, `/inbox` and the request itself: five routes re-rendered to
 * change one status. The reads are two query keys now, split by what moves.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. Every role and department
 * decision arrives as `viewer`, computed on the server — `lib/auth/authorization.ts`
 * is `server-only`, deliberately, and "all role/department scoping goes through
 * it" (CLAUDE.md) is exactly the rule a client component deciding its own scope
 * would break. `waitingOnMe` runs in the fetcher against that viewer, and it is
 * the SAME function the dashboard tile counts from, so the count that sends
 * somebody here and the list they arrive at cannot disagree. All of it is
 * PRESENTATION: `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` are the authority.
 *
 * Two sections on one page rather than two routes, because for a team leader
 * they are the same errand: "what do I owe, and what does anyone owe me". A
 * member simply sees one section, since the other is always empty for them.
 *
 * No <h1>. The breadcrumb is the page label; the two sections keep their own
 * <h2> because "pending your approval" and "mine" are genuinely different lists
 * and nothing else on the screen distinguishes them.
 * ------------------------------------------------------------------------
 */

/**
 * The URL contract, unchanged and still the shareable source of truth.
 *
 * Read on the server, passed down as a prop. Deliberately NOT re-read here with
 * `useSearchParams`: the page already awaited them, and two readings of the same
 * URL is how a key and a query drift by one navigation.
 */
export type ApprovalsSearchParams = {
  /**
   * F — `?type=` and `?date=`, handed over by the DTR shortcut.
   *
   * Narrowed by `narrowRequestPrefill`, which returns undefined per field rather
   * than throwing: a mangled link should open the plain dialog, not an error
   * page. Same posture `/timesheet` takes with `?week=banana`.
   */
  type?: string | string[];
  date?: string | string[];
  /** P7-40. The scheduled time the DTR suggests. A seed, not an assertion. */
  time?: string | string[];
  sort?: string | string[];
  dir?: string | string[];
  page?: string;
  size?: string;
};

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export function ApprovalsView({
  params,
  viewer,
}: {
  params: ApprovalsSearchParams;
  /** Every role, department and eligibility decision, made on the server. */
  viewer: ApprovalsViewer;
}) {
  const prefill = narrowRequestPrefill(params);

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);

  const rawSort = first(params.sort);
  /* `undefined` when the URL named no sort we recognise, and that distinction is
     load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
     collapsed into a resolved sort. The allowlist and the order map live in the
     fetcher, beside the `.order()` they pick a column for. */
  const requestedSort: ApprovalSort | undefined = isApprovalSort(rawSort) ? rawSort : undefined;
  const dir = first(params.dir);

  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie`.
   */
  const queueQuery = useQuery({
    queryKey: qk.approvals({
      page: page > 1 ? String(page) : undefined,
      size: pageSize !== PAGE_SIZES[0] ? String(pageSize) : undefined,
      sort: requestedSort,
      dir: requestedSort && dir === "desc" ? "desc" : undefined,
    }),
    queryFn: () =>
      fetchApprovalsQueue(browserClient(), viewer, { page, pageSize, requestedSort, dir }),
  });

  /*
   * The filing dialog's four pickers.
   *
   * ⚠️ ITS OWN KEY, BECAUSE IT MOVES ON A DIFFERENT SCHEDULE. Leave types and
   * reliever candidates are effectively reference data; the queue is refetched
   * after every decision. In the RSC they were siblings in one wave, so
   * approving a request re-read the whole leave-type list, the caller's
   * entitlements, every active colleague and a two-query scan of their open
   * tasks. None of that can have changed because somebody approved a request.
   *
   * ⚠️ NO EMPTY-KEY FILTER BAG. `qk.approvals({})` and `qk.approvals({page: "2"})`
   * are different entries by design, and the pickers belong to neither — they
   * are the same for every page of the queue, which is exactly what the bare
   * `{ options: "filing" }` segment says.
   */
  const optionsQuery = useQuery({
    queryKey: qk.approvals({ options: "filing" }),
    queryFn: () => fetchFilingOptions(browserClient(), viewer),
  });

  const queue = queueQuery.data;
  const total = queue?.mineTotal ?? 0;

  /* Rebuilt from the narrowed values, so the paginator cannot drop the sort. */
  function hrefFor(target: number) {
    const next = new URLSearchParams();
    /* Only what the URL actually named. Emitting the default back would be a
       link claiming a choice nobody made, and `dir` without a `sort` beside it
       now means nothing at all. */
    if (requestedSort) next.set("sort", requestedSort);
    if (requestedSort && dir === "desc") next.set("dir", "desc");
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/approvals?${query}` : "/approvals";
  }

  return (
    <PageShell className="gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Leave, time corrections and reimbursements. Your remaining leave shows as you file — it is
          what HR allocated for the year less what you have had approved, and nothing here refuses a
          request that would overdraw it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* P7-53. Beside the filing button because this is the other thing
              somebody does with their own leave figures, and there is nowhere
              else on this screen those figures appear — the balances render
              inside the dialog, one type at a time, as you file. */}
          <MyLeaveRecordButton year={currentBalanceYear(todayInAppZone())} />

          {/*
            ⚠️ THE DIALOG WAITS FOR ITS PICKERS AND IS NOT RENDERED WITHOUT THEM.
            Every field in it is seeded from something `fetchFilingOptions`
            returns, and `useState` initialisers run once — a dialog mounted on
            empty arrays would offer no leave types, no relievers and no tasks,
            and would keep offering none after the data arrived. An absent button
            for a moment is honest; a filing form that cannot be filed is not.

            A failed read is worse still and gets said out loud: "you have no
            open tasks to hand over" and "you have no leave types" are both
            sentences somebody would act on.
          */}
          {optionsQuery.isError ? (
            <QueryError what="the filing options" message={optionsQuery.error.message} />
          ) : optionsQuery.data ? (
            <NewRequestDialog
              leaveTypes={optionsQuery.data.leaveTypes}
              balances={optionsQuery.data.balances ?? []}
              relieverCandidates={optionsQuery.data.relieverCandidates}
              handoverTasks={optionsQuery.data.handoverTasks}
              // P9-01. So the dialog can say "we could not load your tasks"
              // rather than "you have no tasks", which are opposite claims and
              // only one of them is ever true by accident.
              handoverTasksFailed={optionsQuery.data.handoverTasksFailed}
              // Read from the resolved auth context rather than re-queried: it
              // is the same row the submit function will consult, so the form
              // cannot disagree with the rule that refuses it.
              hasDepartment={viewer.hasDepartment}
              // P8-01: `roleAtLeast`, not `=== "admin"` — the top rung is now
              // `owner`, and the equality would be true for nobody. Resolved on
              // the server; see `page.tsx`.
              isAdmin={viewer.isAdmin}
              prefill={{
                ...prefill,
                // Opened only when something survived narrowing. Landing on
                // /approvals with no parameters must not pop a dialog over the
                // queue somebody came to read.
                // `time` is deliberately NOT in this test. A URL carrying only a
                // time names no day and no kind of request — there is nothing to
                // open the dialog onto, and doing so would present an empty form
                // with one field mysteriously filled.
                openOnMount: Boolean(prefill.type || prefill.date),
              }}
            />
          ) : null}
        </div>
      </div>

      {/*
        ⚠️ THE FAILURE IS SAID ONCE, ABOVE BOTH SECTIONS, AND IT REPLACES THEM.
        The two lists and the weeks queue share one cache entry, so a broken read
        breaks all three — and the alternative is three empty tables, one of
        which reads "You have not submitted any requests" and another of which
        simply does not render. An empty APPROVALS queue is the one people
        believe and act on.
      */}
      {queueQuery.isError ? (
        <QueryError what="your approvals" message={queueQuery.error.message} />
      ) : queueQuery.isPending ? (
        <TableSkeleton columns={4} rows={6} />
      ) : (
        <>
          {/* Approver queue first when there is one: it is the thing with somebody
              else waiting on the other end. Rendered only when non-empty, so it
              needs no empty state of its own. */}
          {queue!.pendingOnMe.length > 0 ? (
            <Section
              title="Pending your approval"
              description="Requests from the departments you lead."
              rows={queue!.pendingOnMe}
              showWho
              reviewerNames={queue!.reviewerNames}
              empty={null}
            />
          ) : null}

          {/* The other thing waiting on a lead, and the one that had no queue at
              all — the decision itself stays on the team week grid. Rendered when
              there is something to show OR when the read FAILED: an empty approvals
              queue is the one people believe and act on, so a broken query must not
              be able to look like an empty one. Hidden entirely for a member, who
              approves nothing and would otherwise get a heading with a permanent
              empty table under it. */}
          {viewer.isApprover && (queue!.weeks.length > 0 || queue!.weeksError) ? (
            <>
              <TimesheetWeeksSection
                rows={queue!.weeks}
                empty={
                  queue!.weeksError ? (
                    <QueryError
                      what="timesheet weeks awaiting you"
                      message={queue!.weeksError.message}
                    />
                  ) : null
                }
              />
              {queue!.weeksTruncated ? (
                <p className="text-xs text-muted-foreground">
                  Showing the first {APPROVALS_PAGE_SIZE} weeks handed in.
                </p>
              ) : null}
            </>
          ) : null}

          <Section
            title="My requests"
            description="Everything you have submitted."
            rows={queue!.mine}
            showWho={false}
            reviewerNames={queue!.reviewerNames}
            empty={
              <EmptyState
                icon={<Inbox />}
                title="You have not submitted any requests"
                description="Leave, a missed time in or out, and reimbursements all start here. Your department lead decides them — you cannot decide your own."
              />
            }
          />

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            hrefFor={hrefFor}
            basePath="/approvals"
          />

          {queue!.truncated ? (
            <p className="text-xs text-muted-foreground">
              {/* About the QUEUE only — "My requests" pages properly above.
                  A queue this long is a backlog, not a paging problem. */}
              Showing the first {APPROVALS_PAGE_SIZE} awaiting you. Clear some to see the rest.
            </p>
          ) : null}
        </>
      )}
    </PageShell>
  );
}

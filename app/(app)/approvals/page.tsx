import type { Metadata } from "next";
import { Inbox } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { narrowRequestPrefill } from "@/lib/schemas/internal-requests";
import { currentBalanceYear, leaveTypeApplies } from "@/lib/schemas/leave-balances";
import { createClient } from "@/utils/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import { MyLeaveRecordButton } from "./my-leave-record";
import { NewRequestDialog } from "./new-request-dialog";
import { Section, type Row } from "./approvals-table";

/** Rows rendered. The query asks for one more so the cap is detectable. */
const APPROVALS_PAGE_SIZE = 200;

export const metadata: Metadata = { title: "Approvals" };

/**
 * P5-10 — my requests, and requests pending my approval.
 *
 * Two sections on one page rather than two routes, because for a team leader
 * they are the same errand: "what do I owe, and what does anyone owe me". A
 * member simply sees one section, since the other is always empty for them.
 *
 * ONE QUERY FOR BOTH. RLS already returns your own requests plus your
 * departments'; splitting them here is a partition of rows we already hold, not
 * a second round trip — and it means the two lists cannot disagree about a row
 * that changed between them.
 *
 * No <h1>. The breadcrumb is the page label; the two sections keep their own
 * <h2> because "pending your approval" and "mine" are genuinely different lists
 * and nothing else on the screen distinguishes them.
 */


export default async function ApprovalsPage({
  searchParams,
}: {
  /**
   * F — `?type=` and `?date=`, handed over by the DTR shortcut.
   *
   * Narrowed by `narrowRequestPrefill`, which returns undefined per field rather
   * than throwing: a mangled link should open the plain dialog, not an error
   * page. Same posture `/timesheet` takes with `?week=banana`.
   */
  searchParams: Promise<{
    type?: string | string[];
    date?: string | string[];
    /** P7-40. The scheduled time the DTR suggests. A seed, not an assertion. */
    time?: string | string[];
    sort?: string | string[];
    dir?: string | string[];
    page?: string;
    size?: string;
  }>;
}) {
  const context = await requireAuthContext();
  const supabase = await createClient();
  const params = await searchParams;
  const prefill = narrowRequestPrefill(params);

  /*
   * P7-66 — THE SORT THE HEADERS WERE ALREADY WRITING.
   *
   * P7-64 gave this table `urlSort` and sortable headers, and never taught the
   * server to read the param — so clicking a heading changed the URL and
   * nothing else. This is the missing half.
   *
   * `?sort=` is user input, so it selects a LITERAL column rather than being
   * interpolated into `.order()`.
   */
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const SORTS = ["request", "submitted", "status", "decided"] as const;
  type Sort = (typeof SORTS)[number];
  const rawSort = first(params.sort);
  const sort: Sort = (SORTS as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as Sort)
    : "submitted";

  const ORDER_COLUMN: Record<Sort, string> = {
    // The "Request" heading reads as its type plus its detail, and the type is
    // the only part of that the database can order by.
    request: "request_type",
    submitted: "created_at",
    status: "status",
    decided: "reviewed_at",
  };

  // A queue reads newest-first; anything else reads ascending.
  const ascending = first(params.dir)
    ? first(params.dir) !== "desc"
    : !(sort === "submitted" || sort === "decided");

  /*
   * P7-66 — TWO QUERIES, BECAUSE THE PAGE IS TWO LISTS.
   *
   * This was one `.limit(200 + 1)` fetch split into "mine" and "pending on me"
   * afterwards, which could not be paged: page 2 of a combined query might hold
   * all of one list and none of the other, and the two sections would disagree
   * about what page they were on.
   *
   * They are also different SHAPES of data. "My requests" grows forever and is
   * read as history — it pages. "Pending on me" is a queue of work awaiting an
   * action; if it ever reaches 200 the problem is not pagination. It keeps the
   * detectable cap it had.
   */
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);
  const rangeFrom = (page - 1) * pageSize;

  const SELECT =
    "*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name)";

  const [
    { data: mineData, error: requestsError, count: mineCount },
    { data: queueData },
    { data: leaveTypes },
    { data: balances },
  ] = await Promise.all([
    supabase
      .from("vizserve_pms_internal_requests")
      .select(SELECT, { count: "exact" })
      .eq("requester_id", context.userId)
      .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
      .range(rangeFrom, rangeFrom + pageSize - 1),

    /*
     * Everything visible that is NOT mine is, by RLS, a department I lead —
     * so this needs no department filter. Pending only: a decided request is
     * history and lives on its requester's own list.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      .select(SELECT)
      .neq("requester_id", context.userId)
      .eq("status", "PENDING_REVIEW")
      .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
      // One more than shown, so truncation is detectable rather than silent.
      .limit(APPROVALS_PAGE_SIZE + 1),

    // P7-12 — the picker's options.
    //
    // ACTIVE ONLY, and ordered by the list's own `sort_order` rather than
    // alphabetically: a retired type stays valid on the requests that already
    // reference it and must not be selectable for a new one, and the seeded
    // order puts Vacation and Sick first because that is what almost everybody
    // picks.
    // P7-45 — `applies_to_gender` comes along so the picker can drop the types
    // this person is not eligible for. Filtered BELOW rather than in the query,
    // because "or the column is null" plus "or my gender is null" is a
    // three-way condition that reads far better as the shared predicate than as
    // a PostgREST `or=` string nobody can check.
    supabase
      .from("vizserve_pms_leave_types")
      .select("id, label, applies_to_gender")
      .eq("is_active", true)
      .order("sort_order"),

    // P7-33 — the caller's own remaining days, per type.
    //
    // No arguments: the function defaults to the caller and to the current year
    // in Manila. Passing the user id explicitly would be the same query with one
    // more thing that can be wrong, and the function checks authority either way
    // — it raises for a caller who is not the subject, their lead, or an admin.
    //
    // A failure here is left to fall through as `null`. The balance is a hint
    // beside a field; the page it decorates is somebody's approval queue, and
    // that must render whether or not the entitlement figures came back.
    supabase.rpc("vizserve_pms_leave_balance_summary", {}),
  ]);

  /*
   * P7-45 — only the types this person may actually file.
   *
   * Maternity, Special Leave for Women and VAWC are FEMALE; Paternity is MALE;
   * everything else applies to everyone. A gender that was never recorded sees
   * the whole list — `leaveTypeApplies` and the database trigger agree on that,
   * and they have to: a picker offering something the insert then refuses is
   * worse than either rule on its own.
   */
  const pickableLeaveTypes = (leaveTypes ?? []).filter((type) =>
    leaveTypeApplies(type.applies_to_gender, context.gender),
  );

  const mine = (mineData ?? []) as unknown as Row[];
  const queue = (queueData ?? []) as unknown as Row[];
  const truncated = queue.length > APPROVALS_PAGE_SIZE;
  const pendingOnMe = truncated ? queue.slice(0, APPROVALS_PAGE_SIZE) : queue;
  const rows = [...mine, ...pendingOnMe];
  const total = mineCount ?? 0;

  /* Rebuilt from the narrowed values, so the paginator cannot drop the sort. */
  function hrefFor(target: number) {
    const next = new URLSearchParams();
    if (sort !== "submitted") next.set("sort", sort);
    if (first(params.dir) === "desc") next.set("dir", "desc");
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/approvals?${query}` : "/approvals";
  }

  /*
   * P7-66 — names for the Decided column.
   *
   * One `in` query over the reviewers actually on screen rather than a join on
   * the main select: `reviewed_by` is null on every pending row, so joining
   * would widen the hot query to answer a question only the decided rows ask.
   */
  const reviewerIds = [...new Set(rows.map((row) => row.reviewed_by).filter(Boolean))] as string[];

  const { data: reviewers } =
    reviewerIds.length > 0
      ? await supabase.from("vizserve_pms_users").select("id, full_name").in("id", reviewerIds)
      : { data: null };

  /* A plain object: a Map cannot cross the RSC boundary. */
  const reviewerNames = Object.fromEntries(
    (reviewers ?? []).map((person) => [person.id, person.full_name]),
  );

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
          <NewRequestDialog
          leaveTypes={pickableLeaveTypes}
          balances={balances ?? []}
          // Read from the resolved auth context rather than re-queried: it is
          // the same row the submit function will consult, so the form cannot
          // disagree with the rule that refuses it.
          hasDepartment={Boolean(context.primaryDepartmentId)}
          isAdmin={context.role === "admin"}
          prefill={{
            ...prefill,
            // Opened only when something survived narrowing. Landing on
            // /approvals with no parameters must not pop a dialog over the queue
            // somebody came to read.
            // `time` is deliberately NOT in this test. A URL carrying only a
            // time names no day and no kind of request — there is nothing to
            // open the dialog onto, and doing so would present an empty form
            // with one field mysteriously filled.
            openOnMount: Boolean(prefill.type || prefill.date),
          }}
          />
        </div>
      </div>

      {/* Approver queue first when there is one: it is the thing with somebody
          else waiting on the other end. Rendered only when non-empty, so it
          needs no empty state of its own. */}
      {pendingOnMe.length > 0 ? (
        <Section
          title="Pending your approval"
          description="Requests from the departments you lead."
          rows={pendingOnMe}
          showWho
          reviewerNames={reviewerNames}
          empty={null}
        />
      ) : null}

      <Section
        title="My requests"
        description="Everything you have submitted."
        rows={mine}
        showWho={false}
        reviewerNames={reviewerNames}
        empty={
          requestsError ? (
            <QueryError what="your requests" message={requestsError.message} />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title="You have not submitted any requests"
              description="Leave, a missed time in or out, and reimbursements all start here. Your department lead decides them — you cannot decide your own."
            />
          )
        }
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={hrefFor}
        basePath="/approvals"
      />

      {truncated ? (
        <p className="text-xs text-muted-foreground">
          {/* Now about the QUEUE only — "My requests" pages properly above.
              A queue this long is a backlog, not a paging problem. */}
          Showing the first {APPROVALS_PAGE_SIZE} awaiting you. Clear some to see the rest.
        </p>
      ) : null}
    </PageShell>
  );
}

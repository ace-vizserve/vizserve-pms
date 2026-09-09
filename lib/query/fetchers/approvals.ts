import type { SupabaseClient } from "@supabase/supabase-js";

/*
 * ⚠️ ALL FOUR COME FROM `lib/approvals-queue.ts`, NOT FROM ITS `-server` TWIN,
 * AND THE DISTINCTION IS THE WHOLE OF P12-15. That module imports
 * `lib/auth/authorization.ts`, which is `server-only`, so importing ANY name
 * from it here would drag `server-only` into the browser bundle — a build
 * failure `tsc --noEmit`, eslint and vitest are all blind to.
 *
 * `waitingOnMe` in particular is the ONE definition of "is this mine to decide",
 * shared with the dashboard tile so the count that sends somebody here and the
 * list they land on cannot disagree. `ApprovalsViewer` is a superset of the
 * `{userId, role, managedDepartmentIds}` it takes, so the viewer passes straight
 * through and the rule is never copied.
 */
import {
  listOwedAsReliever,
  listPendingTimesheetWeeks,
  waitingOnMe,
  type PendingWeek,
} from "@/lib/approvals-queue";
import type { Database, LeaveBalanceSummaryRow } from "@/lib/database.types";
import { parse, parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  affectedWeekSchema,
  handoverTaskSchema,
  internalDecisionRowSchema,
  internalRequestDetailSchema,
  internalRequestListRowSchema,
  personNameSchema,
  pickableLeaveTypeSchema,
  relieverCandidateSchema,
  relieverRowSchema,
  type AffectedWeek,
  type ApprovalsViewer,
  type HandoverTask,
  type InternalDecisionRow,
  type InternalRequestDetail,
  type InternalRequestListRow,
  type PickableLeaveType,
  type RelieverCandidate,
  type RelieverRow,
} from "@/lib/schemas/internal-approvals";
import { leaveTypeApplies } from "@/lib/schemas/leave-balances";

/**
 * P12-19 — the reads behind `/approvals` and `/approvals/[id]`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `/approvals` was an RSC awaiting EIGHT queries in one
 * wave and then a ninth keyed by the reviewers it had just fetched; the detail
 * page awaited a row and then three more. Deciding anything called
 * `revalidatePath` on `/approvals`, `/`, `/dashboard`, `/inbox` and the request
 * itself — five routes re-rendered to change one status.
 *
 * ⚠️ `qk.approvals(f)` AND `qk.requests(f)` ARE SEPARATE PREFIXES AND STAY THAT
 * WAY. Internal approvals and client Gate 1 look mergeable and are not:
 * different tables, different auth models, different lifecycles. Settled in
 * CLAUDE.md; a shared prefix here would be the first step towards unifying them.
 *
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER. Every table below scopes by policy
 * through `vizserve_pms_manages_department` — "everything visible that is NOT
 * mine is, by RLS, a department I lead". The `.eq("requester_id", …)` and
 * `.neq(…)` filters are about WHICH ROWS each list wants, not about who may see
 * them, and `waitingOnMe` narrows further FOR DISPLAY only.
 *
 * ⚠️ AND FOUR OF THESE READS DELIBERATELY DO NOT THROW. `listPendingTimesheetWeeks`
 * and `listOwedAsReliever` keep the `{rows, error}` / empty-set shapes they had,
 * because `/` and `/dashboard` still call them from Server Components with no
 * error boundary above them — `lib/approvals-queue.ts` argues both at their own
 * definitions. Everything else throws.
 * ------------------------------------------------------------------------
 */

/**
 * The client shape these fetchers need.
 *
 * ⚠️ THE WHOLE `SupabaseClient`, NOT A `Pick`, AND THIS IS THE ONE FETCHER FILE
 * THAT NEEDS IT. `listPendingTimesheetWeeks` and `listOwedAsReliever` are shared
 * verbatim with `/` and `/dashboard`, which hand them a server client typed as
 * `SupabaseClient<Database>` — so narrowing here would mean either widening
 * their signature or keeping two. The browser client satisfies it.
 */
export type ApprovalsReadClient = SupabaseClient<Database>;

/**
 * ⚠️ THE SELECT STRING IS ONE LITERAL, NOT A CONCATENATION. PostgREST's
 * generated types parse this at the TYPE LEVEL, and a `+` makes it an opaque
 * `string` — every row then comes back as `GenericStringError` and the whole
 * query loses its typing. The embed constraint is named because
 * `vizserve_pms_internal_requests` has more than one FK to `vizserve_pms_users`,
 * and an unqualified embed is a PGRST201 that takes the query rather than the
 * column.
 */
const LIST_SELECT =
  "*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name)";

/* -------------------------------------------------------------------------- */
/* The queue.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * P7-66 — THE SORT ALLOWLIST, MOVED OUT OF THE PAGE.
 *
 * P7-64 gave this table `urlSort` and sortable headers and never taught the
 * server to read the param, so clicking a heading changed the URL and nothing
 * else. `?sort=` is user input, so it selects a LITERAL column rather than being
 * interpolated into `.order()`.
 */
export const APPROVAL_SORTS = ["request", "submitted", "status", "decided"] as const;
export type ApprovalSort = (typeof APPROVAL_SORTS)[number];

export function isApprovalSort(value: string | undefined): value is ApprovalSort {
  return typeof value === "string" && (APPROVAL_SORTS as readonly string[]).includes(value);
}

/**
 * The order applied when the URL asks for none: a queue reads newest-first.
 *
 * `approvals-table.tsx` passes the same pair to `DataTable` as `defaultSort`,
 * which is the only reason its headers can draw an arrow for an order nobody put
 * in the query string. BOTH sections order by it, so one default covers both.
 */
export const DEFAULT_APPROVAL_SORT = { sort: "submitted", ascending: false } as const;

const ORDER_COLUMN: Record<ApprovalSort, string> = {
  // The "Request" heading reads as its type plus its detail, and the type is the
  // only part of that the database can order by.
  request: "request_type",
  submitted: "created_at",
  status: "status",
  decided: "reviewed_at",
};

/** Rows rendered in the approver queue. The query asks for one more so the cap is detectable. */
export const APPROVALS_PAGE_SIZE = 200;

export type ApprovalsParams = {
  page: number;
  pageSize: number;
  requestedSort: ApprovalSort | undefined;
  dir: string | undefined;
};

export type ApprovalsQueue = {
  /** Everything I have submitted. Pages, because it grows forever and reads as history. */
  mine: InternalRequestListRow[];
  /** Rows matching, across every page. Drives the paginator. */
  mineTotal: number;
  /** Waiting on ME, already narrowed by `waitingOnMe`. Capped, not paged. */
  pendingOnMe: InternalRequestListRow[];
  /** True when the cap was hit — a queue this long is a backlog, not a paging problem. */
  truncated: boolean;
  /** P8 — the third queue. Weeks handed in and waiting on somebody else. */
  weeks: PendingWeek[];
  weeksTruncated: boolean;
  /** Kept rather than thrown: an empty weeks queue must not be able to look like a broken one. */
  weeksError: { message: string } | null;
  /** Reviewer id → name, for the Decided column. */
  reviewerNames: Record<string, string>;
};

/**
 * `qk.approvals(filters)` — all three queues, in one entry.
 *
 * ⚠️ TWO QUERIES FOR THE INTERNAL REQUESTS, BECAUSE THE PAGE IS TWO LISTS. This
 * was one `.limit(200 + 1)` fetch split afterwards, which could not be paged:
 * page 2 of a combined query might hold all of one list and none of the other,
 * and the two sections would disagree about what page they were on. They are
 * also different SHAPES of data — "my requests" grows forever and is read as
 * history, so it pages; "pending on me" is work awaiting an action, and if it
 * ever reaches 200 the problem is not pagination.
 *
 * ⚠️ THE THIRD QUEUE IS HERE BECAUSE THE DASHBOARD COUNTS IT. A lead approves
 * client requests, internal requests AND handed-in timesheet weeks, and this
 * page once read internal requests alone while the tile counted all three —
 * which shipped "Pending approvals: 0" for a lead with seven items, twice.
 * Sending somebody to a queue that shows fewer things than the count that sent
 * them is the same class of lie.
 *
 * ⚠️ AND ALL THREE SHARE ONE CACHE ENTRY DELIBERATELY. They are one screen, they
 * are invalidated by the same writes, and three keys would let the two internal
 * sections disagree about a row that changed between their refetches — which is
 * exactly the argument for one query the RSC made about one wave.
 */
export async function fetchApprovalsQueue(
  client: ApprovalsReadClient,
  viewer: ApprovalsViewer,
  params: ApprovalsParams,
): Promise<ApprovalsQueue> {
  const sort: ApprovalSort = params.requestedSort ?? DEFAULT_APPROVAL_SORT.sort;
  /* ONE SOURCE FOR THE DIRECTION. An explicit sort obeys `?dir=` — ascending
     unless it says otherwise, which is why the table leaves `asc` out of the URL
     — and no explicit sort takes the default's. Deciding it from the column name
     instead, as this once did, meant a click on "Submitted" or "Decided" drew an
     ascending arrow over descending rows and neither could be reversed. */
  const ascending = params.requestedSort ? params.dir !== "desc" : DEFAULT_APPROVAL_SORT.ascending;

  const rangeFrom = (params.page - 1) * params.pageSize;

  const mineQuery = client
    .from("vizserve_pms_internal_requests")
    .select(LIST_SELECT, { count: "exact" })
    .eq("requester_id", viewer.userId)
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    .range(rangeFrom, rangeFrom + params.pageSize - 1);

  const [mineResult, queueRows, weeksQueue, owedAsReliever] = await Promise.all([
    mineQuery,

    /*
     * Everything visible that is NOT mine is, by RLS, a department I lead — so
     * this needs no department filter. Pending only: a decided request is
     * history and lives on its requester's own list.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_internal_requests")
        .select(LIST_SELECT)
        .neq("requester_id", viewer.userId)
        .eq("status", "PENDING_REVIEW")
        .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
        // One more than shown, so truncation is detectable rather than silent.
        .limit(APPROVALS_PAGE_SIZE + 1),
    ),

    /*
     * The SHARED definition, not a second query — `listPendingTimesheetWeeks` is
     * what `/` and `/dashboard` count and list from, so this page cannot
     * disagree with the tile that sent somebody here.
     *
     * NO DEPARTMENT FILTER, like everything else here: the weeks policy scopes
     * by the department snapshotted at submission. It also drops the caller's
     * OWN week — a lead hands one in like anybody else and cannot decide it.
     */
    listPendingTimesheetWeeks(client, viewer.userId, viewer.isApprover, APPROVALS_PAGE_SIZE + 1),

    /*
     * P9-01 — the requests where I am a reliever who has not answered.
     *
     * Read for EVERYBODY, not behind `isApprover`: a reliever is usually a plain
     * member, and the gate that returns nothing for a member is exactly what
     * would hide the one decision they are owed.
     */
    listOwedAsReliever(client, viewer.userId),
  ]);

  if (mineResult.error) {
    // Raised through `read()` so the message and the PostgREST code are shaped
    // like every other failed read; `count: "exact"` is why it cannot go through
    // `read()` directly.
    await read<unknown>(Promise.resolve({ data: null, error: mineResult.error }));
  }

  const mine = parseAll(internalRequestListRowSchema, mineResult.data ?? [], "your requests");

  /*
   * ⚠️ P9-04 — FILTERED, WHERE IT USED TO BE TAKEN WHOLE.
   *
   * "Pending and not mine" meant "mine to decide" until the chain, and it means
   * neither direction now: a lead can SEE a stage-1 request the relievers still
   * hold, and a manager is owed stage-3 requests in departments they do not
   * lead. `waitingOnMe` is the one place that rule lives — it also backs the
   * dashboard tile, so the count that sends somebody here and the list they
   * arrive at cannot disagree.
   *
   * ⚠️ FILTERED IN FULL AND SLICED AFTER, never `.limit()`ed and then filtered.
   * The rows the query returns are not the rows this person is owed, so taking
   * the first 200 and THEN narrowing would show three, or none, while others sat
   * below the cut — a queue that silently shortens is the failure this whole
   * module was extracted to stop.
   */
  const queue = parseAll(
    internalRequestListRowSchema,
    queueRows,
    "requests awaiting you",
  ).filter((row) => waitingOnMe(row, viewer, owedAsReliever));

  const truncated = queue.length > APPROVALS_PAGE_SIZE;
  const pendingOnMe = truncated ? queue.slice(0, APPROVALS_PAGE_SIZE) : queue;

  /* Same trick as the queue: the read asked for one more than is shown, so a
     truncated list is detectable instead of silently short. */
  const weeksTruncated = weeksQueue.rows.length > APPROVALS_PAGE_SIZE;

  /*
   * P7-66 — names for the Decided column.
   *
   * ONE `in` QUERY over the reviewers actually on screen rather than a join on
   * the main select: `reviewed_by` is null on every pending row, so joining
   * would widen the hot query to answer a question only the decided rows ask.
   */
  const reviewerIds = [
    ...new Set([...mine, ...pendingOnMe].map((row) => row.reviewed_by).filter(Boolean)),
  ] as string[];

  const reviewers =
    reviewerIds.length > 0
      ? await read<unknown[]>(
          client.from("vizserve_pms_users").select("id, full_name").in("id", reviewerIds),
        )
      : [];

  return {
    mine,
    mineTotal: mineResult.count ?? 0,
    pendingOnMe,
    truncated,
    weeks: weeksTruncated ? weeksQueue.rows.slice(0, APPROVALS_PAGE_SIZE) : weeksQueue.rows,
    weeksTruncated,
    weeksError: weeksQueue.error,
    reviewerNames: Object.fromEntries(
      parseAll(personNameSchema, reviewers, "reviewers").map((person) => [
        person.id,
        person.full_name,
      ]),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* The filing dialog's pickers.                                                */
/* -------------------------------------------------------------------------- */

export type FilingOptions = {
  leaveTypes: PickableLeaveType[];
  /** Null when the entitlement figures could not be read. See below. */
  balances: LeaveBalanceSummaryRow[] | null;
  relieverCandidates: RelieverCandidate[];
  handoverTasks: HandoverTask[];
  /** So the dialog can say "we could not load your tasks", never "you have none". */
  handoverTasksFailed: boolean;
};

/**
 * `qk.approvals(...)` + the filing dialog's four pickers.
 *
 * ⚠️ ITS OWN KEY, BECAUSE IT MOVES ON A DIFFERENT SCHEDULE FROM THE QUEUE. Leave
 * types and reliever candidates are effectively reference data; the queue is
 * refetched after every decision. Folding them in would re-read the whole
 * directory and a two-query task scan every time somebody approved a request.
 */
export async function fetchFilingOptions(
  client: ApprovalsReadClient,
  viewer: ApprovalsViewer,
): Promise<FilingOptions> {
  const [leaveTypeRows, balanceResult, candidateRows, handover] = await Promise.all([
    /*
     * P7-12 — the picker's options.
     *
     * ACTIVE ONLY, and ordered by the list's own `sort_order` rather than
     * alphabetically: a retired type stays valid on the requests that already
     * reference it and must not be selectable for a new one, and the seeded
     * order puts Vacation and Sick first because that is what almost everybody
     * picks.
     *
     * P7-45 — `applies_to_gender` comes along so the picker can drop the types
     * this person is not eligible for. Filtered BELOW rather than in the query,
     * because "or the column is null" plus "or my gender is null" is a three-way
     * condition that reads far better as the shared predicate than as a
     * PostgREST `or=` string nobody can check.
     *
     * P9-01 — `requires_reliever` is what makes the hand-over block appear. The
     * dialog asks the CHOSEN TYPE rather than testing for the code "VACATION",
     * so HR ticking another type needs no change in either place.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_leave_types")
        .select("id, label, applies_to_gender, requires_reliever")
        .eq("is_active", true)
        .order("sort_order"),
    ),

    /*
     * P7-33 — the caller's own remaining days, per type.
     *
     * No arguments: the function defaults to the caller and to the current year
     * in Manila. Passing the user id explicitly would be the same query with one
     * more thing that can be wrong, and the function checks authority either way
     * — it raises for a caller who is not the subject, their lead, or an admin.
     *
     * ⚠️ THE ONE READ HERE THAT IS ALLOWED TO FAIL QUIETLY, AND IT KEEPS THAT.
     * The balance is a HINT beside a field; the page it decorates is somebody's
     * approval queue, and that must render whether or not the entitlement
     * figures came back. `null` rather than `[]` is what makes the dialog able
     * to say "we could not load these" instead of "you have no days left" —
     * which is the wrong zero this whole phase is about, in the one place it
     * would stop somebody filing legitimate leave.
     */
    client.rpc("vizserve_pms_leave_balance_summary", {}),

    /*
     * P11-11 — who this person may name as a reliever: ANY ACTIVE COLLEAGUE.
     *
     * ⚠️ AN RPC, AND THE OLD `.eq()` DID NOT MERELY MOVE. Deleting the filter
     * would have changed nothing: `vizserve_pms_users` is readable to your own
     * department, your managed departments and HR, so for a plain member RLS WAS
     * the filter and the list would have come back the same length.
     * `vizserve_pms_reliever_candidates` is `security definer` and returns two
     * columns — id and name. Widening the table's policy instead would have put
     * email, role, `is_hr` and `app_access` in front of everybody to populate a
     * dropdown.
     *
     * The function answers for somebody with no department too, which is the
     * account that used to get `{ data: null }` and an empty picker.
     */
    read<unknown[]>(client.rpc("vizserve_pms_reliever_candidates")),

    fetchHandoverTasks(client, viewer.userId),
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
  const leaveTypes = parseAll(
    pickableLeaveTypeSchema,
    leaveTypeRows,
    "leave types",
  ).filter((type) => leaveTypeApplies(type.applies_to_gender, viewer.gender));

  return {
    leaveTypes,
    balances: balanceResult.error
      ? null
      : ((balanceResult.data ?? []) as LeaveBalanceSummaryRow[]),
    relieverCandidates: parseAll(relieverCandidateSchema, candidateRows, "colleagues"),
    handoverTasks: handover.tasks,
    handoverTasksFailed: Boolean(handover.error),
  };
}

/**
 * P9-01 — the tasks somebody could hand over to a reliever.
 *
 * ⚠️ MOVED HERE FROM `lib/tasks-server.ts` IN P12-19, WITH THE CLIENT AS A
 * PARAMETER AND NOTHING ELSE CHANGED. That module is `server-only` and this is
 * its one caller, which is now a client component. The two queries, the merge,
 * the sort and every comment below are the originals.
 *
 * "Could hand over" is `vizserve_pms_is_on_task` — PIC, QA, or a row in
 * `vizserve_pms_task_assignees` — minus anything already finished.
 *
 * ⚠️ TWO QUERIES, AND THE REASON IS THE BUG THIS REPLACES.
 *
 * The first version built one `or(...)` fragment containing every joined task
 * id. A PostgREST filter travels in the URL, and one real user has 444 rows in
 * `vizserve_pms_task_assignees` — a 16,542-character query string. The request
 * did not return a PostgREST error, it did not return 414; `fetch` itself
 * failed. The page did `data ?? []` and rendered "You have no open tasks to hand
 * over" to somebody with 22 of them.
 *
 * So NOTHING VARIABLE-LENGTH GOES IN A FILTER. Both queries below carry one uuid
 * each, whatever the person's history looks like, and the join table is reached
 * through an `!inner` embed rather than by listing its ids.
 *
 * ⚠️ RETURNS ITS ERROR RATHER THAN THROWING, AND THAT IS NOT A `?? []` IN
 * DISGUISE. An empty list here is a SENTENCE telling somebody they have no work
 * to hand over, which is the wrong zero this phase exists to remove — so the
 * error rides alongside and `handoverTasksFailed` is what the dialog says. It
 * does not throw because it is one field of a filing dialog on a page whose main
 * job is somebody's approval queue, and a failed task scan must not take that
 * down. Same judgement `fetchPendingRequests` records, same mechanism.
 */
export async function fetchHandoverTasks(
  client: ApprovalsReadClient,
  userId: string,
): Promise<{ tasks: HandoverTask[]; error: { message: string } | null }> {
  // Named once: the four statuses split two ways everywhere in this app, and a
  // second spelling here would drift from the submit function's own test.
  const FINISHED = "(COMPLETED,COMPLETED_NO_RESPONSE)";

  const [own, joined] = await Promise.all([
    // The two COLUMNS. Fixed-length filter, always.
    client
      .from("vizserve_pms_tasks")
      .select("id, title, created_at")
      .or(`assignee_id.eq.${userId},qa_assignee_id.eq.${userId}`)
      .not("status", "in", FINISHED),

    /*
     * The JOIN TABLE, walked from its own side.
     *
     * `!inner` makes the embed a real inner join, so filtering the embedded
     * status drops the parent row too — which is what keeps finished tasks out
     * without a second pass. Reading it this way is what removes the id list
     * from the URL entirely.
     */
    client
      .from("vizserve_pms_task_assignees")
      .select("vizserve_pms_tasks!inner(id, title, created_at, status)")
      .eq("user_id", userId)
      .not("vizserve_pms_tasks.status", "in", FINISHED),
  ]);

  const error = own.error ?? joined.error ?? null;

  // A task reached both ways is one task. Somebody is routinely the PIC AND
  // carries a `task_assignees` row for the same work.
  const merged = new Map<string, { id: string; title: string; created_at: string }>();
  for (const task of own.data ?? []) merged.set(task.id, task);
  for (const row of (joined.data ?? []) as unknown as Array<{
    vizserve_pms_tasks: { id: string; title: string; created_at: string } | null;
  }>) {
    if (row.vizserve_pms_tasks) merged.set(row.vizserve_pms_tasks.id, row.vizserve_pms_tasks);
  }

  /*
   * NEWEST FIRST, and it cannot be an `.order()` now that the rows arrive from
   * two places.
   *
   * Newest rather than soonest-due, because the picker shows five and lets you
   * search for the rest: the five you most recently picked up are the five you
   * can recognise from a title, whereas the five due soonest are as likely to be
   * a stale deadline on something finished in all but status. Due date is the
   * right default for a BOARD, which is a different question.
   */
  const tasks = [...merged.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.title.localeCompare(b.title))
    .map(({ id, title }) => ({ id, title }));

  return {
    tasks: parseAll(handoverTaskSchema, tasks, "your open tasks"),
    error: error ? { message: error.message } : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The detail page.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `qk.approval(id)` — the request, its requester and its leave type.
 *
 * ⚠️ AN ERROR IS NOT A 404, AND CONFLATING THEM COST AN AFTERNOON. The RSC read
 * `const { data } = ...` and threw the error away, so THREE very different
 * situations all rendered as the same bare not-found page: the row is outside
 * your scope (correct), the row does not exist (correct), or the query FAILED —
 * a missing GRANT, an embed PostgREST could not resolve, a dropped connection —
 * which is a fault and not a 404 at all.
 *
 * The third is the one this project is most likely to hit: CLAUDE.md opens with
 * "permission denied for table" being a grants diagnosis, and every new
 * migration adds a table or an FK an embed here could trip over. Silently
 * showing 404 for it sends whoever is debugging to look at RLS, which is exactly
 * where the answer is not.
 *
 * `read()` throwing is what makes the two separable. A null return is the
 * genuine "gone, or not yours", and the caller turns it into `notFound()`.
 */
export async function fetchApprovalDetail(
  client: ApprovalsReadClient,
  requestId: string,
): Promise<InternalRequestDetail | null> {
  const row = await read<unknown>(
    client
      .from("vizserve_pms_internal_requests")
      .select(
        // P7-12 — the leave type comes along as an embed rather than a second
        // query. ONE STRING LITERAL: a `+` makes PostgREST's generated types
        // treat it as an opaque `string` and the whole query loses its typing.
        "*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name, email), vizserve_pms_leave_types(label)",
      )
      .eq("id", requestId)
      .maybeSingle(),
  );

  return row === null ? null : parse(internalRequestDetailSchema, row, "this request");
}

export type ApprovalChain = {
  relievers: RelieverRow[];
  decisions: InternalDecisionRow[];
};

/**
 * `qk.approvalPart(id, "chain")` — who has signed, and who is covering.
 *
 * ⚠️ ONE WAVE. Both are keyed by the `id` from the URL and neither needs the
 * request row, which is why they are not gated behind it — the RSC awaited the
 * row and then these, and the relievers read in particular waited on nothing.
 *
 * ⚠️ THE DECISIONS ARE ORDERED ASCENDING AND THE ORDER IS LOAD-BEARING.
 * `vizserve_pms_approvals` HAS NO STAGE COLUMN and should not grow one — P2-00
 * keeps it generic on purpose so timesheet weeks and client requests share it.
 * What makes POSITION sufficient is that the engine writes exactly one row per
 * stage, in order: stage 2 calls `record_decision` and advances, stage 3 calls
 * it again and closes. Stage 1 writes none at all — a reliever's answer lives on
 * their own row. A rejection is terminal at every stage (p9_04), so there can
 * never be a third row, and never a second on a request refused at stage 2.
 *
 * Readable at all only since `p11_01`, which widened the P2-00 policy — it
 * scoped rows to the approver themselves or a lead of the deciding DEPARTMENT,
 * and that department is the requester's, so a manager who leads none got zero
 * rows. The name embed needs the same migration's users policy.
 */
export async function fetchApprovalChain(
  client: ApprovalsReadClient,
  requestId: string,
): Promise<ApprovalChain> {
  const [relieverRows, decisionRows] = await Promise.all([
    /*
     * P9-01 — the hand-over, if there is one.
     *
     * Read for every request rather than only for chained leave: a request that
     * has been approved keeps its relievers, and the page that shows who covered
     * what should still show it afterwards. An unchained request simply gets an
     * empty array, which renders as nothing.
     *
     * The names come through an embed on the same read. Policy-scoped like
     * everything else — a reliever can see their own row, and the requester, the
     * leads and HR can see them all.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_internal_request_relievers")
        .select(
          "id, reliever_id, decision, decided_at, reason, vizserve_pms_users!vizserve_pms_internal_request_relievers_reliever_id_fkey(full_name), vizserve_pms_internal_request_reliever_tasks(task_id, vizserve_pms_tasks(id, title))",
        )
        .eq("request_id", requestId)
        .order("created_at", { ascending: true }),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_approvals")
        .select(
          "decision, reason, created_at, approver_id, vizserve_pms_users!vizserve_pms_approvals_approver_id_fkey(full_name)",
        )
        .eq("entity_type", "internal_request")
        .eq("entity_id", requestId)
        .order("created_at", { ascending: true }),
    ),
  ]);

  return {
    relievers: parseAll(relieverRowSchema, relieverRows, "the hand-over"),
    decisions: parseAll(internalDecisionRowSchema, decisionRows, "the decision history"),
  };
}

/**
 * `qk.approvalPart(id, "weeks")` — P8-05, which timesheet weeks this leave
 * touches.
 *
 * Approved leave lowers what a week has to add up to: a member off Monday and
 * Tuesday is submitting against a 24-hour target, not a 40-hour one. Nothing on
 * this screen said so, so a lead reading an approved request had no way to
 * connect it to the short week it explains — and the two live in different
 * modules with no link between them.
 *
 * A READ AND A LINK, and deliberately nothing more. No foreign key: leave is
 * dated and weeks are keyed by Monday, and a stored pointer between them would
 * have to be maintained on every edit of either. `weeksSpanned` derives the
 * Mondays from the dates already on the row, which is arithmetic, not state.
 *
 * ⚠️ IT DOES NOT RESTATE THE TARGET. The rule that turns a schedule plus days
 * off into a weekly minimum lives in `scheduledWeekMinutes` and in
 * `vizserve_pms_submit_timesheet_week`; a third copy printed here would be a
 * third thing to keep in step, and the week itself shows the figure.
 *
 * No department filter — the weeks policy scopes by the department snapshotted
 * at submission. A lead outside that scope simply gets no rows back and the
 * links still render, which is the correct outcome: the week EXISTS whether or
 * not this reader may see it.
 */
export async function fetchAffectedWeeks(
  client: ApprovalsReadClient,
  requesterId: string,
  weekStarts: readonly string[],
): Promise<AffectedWeek[]> {
  if (weekStarts.length === 0) return [];

  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_timesheet_weeks")
      .select("id, week_start, status")
      .eq("user_id", requesterId)
      .in("week_start", [...weekStarts]),
  );

  return parseAll(affectedWeekSchema, rows, "the weeks this leave touches");
}

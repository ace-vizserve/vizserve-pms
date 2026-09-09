import type { VizservePmsRequestStatus } from "@/lib/database.types";
import { parse, parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import { ilikeAnyOf } from "@/lib/search";
import { capacityRowSchema, type CapacityRow } from "@/lib/schemas/approvals";
import {
  requestAttachmentSchema,
  requestDecisionSchema,
  requestDetailSchema,
  requestFormDetailSchema,
  requestFormFieldSchema,
  requestFormSchema,
  requestLinkedTaskSchema,
  requestListRowSchema,
  reviewCandidateSchema,
  reviewListSchema,
  type RequestAttachment,
  type RequestDecision,
  type RequestDetail,
  type RequestForm,
  type RequestFormDetail,
  type RequestFormField,
  type RequestLinkedTask,
  type RequestListRow,
  type ReviewCandidate,
  type ReviewList,
} from "@/lib/schemas/requests";

import type { TaskReadClient } from "./task";

/**
 * P12-18 — the reads behind `/requests` and `/requests/[id]`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. Both were RSCs. The queue awaited two queries and then a
 * third keyed by the reviewers on the page it had just fetched; the detail page
 * awaited a row, then a batch of five, then a wave of four keyed by the form's
 * department, then a names query — four sequential waves before anything
 * painted, all behind ONE cache entry, the route's own render. Approving at Gate
 * 1 then called `revalidatePath` on both routes plus `/` and `/dashboard`, so
 * one decision re-ran every one of them.
 *
 * ⚠️ `qk.requests(f)` AND `qk.approvals(f)` ARE SEPARATE PREFIXES AND STAY THAT
 * WAY. Client requests and internal approvals look mergeable — both are "a form
 * that gets approved" — and they are not: internal types are a fixed list behind
 * auth, client requests are user-built forms submitted with no session at all.
 * Different tables, different auth models, different lifecycles. Settled in
 * CLAUDE.md; a shared prefix here would be the first step towards unifying them.
 *
 * ⚠️ AND `qk.pendingRequests(f)` IS A THIRD ROW SET UNDER THE SAME `["requests"]`
 * PREFIX. `fetchPendingRequests` in `task-list.ts` reads the Gate 1 queue as the
 * TASK views show it: `status = PENDING_REVIEW`, five columns. This file reads
 * the whole queue with the SLA clock. They must not share a KEY — whichever ran
 * last would win the entry, silently — and they SHOULD share the prefix, so a
 * decision here moves the pending list on `/tasks` too.
 *
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER. `requests readable in department
 * scope` is what makes the Phase 1 exit criterion — "a request appears in the
 * correct TL's queue and nowhere else" — assertable at the API layer rather than
 * by clicking around. There is no `.in("department_id", …)` below and there must
 * not be one.
 *
 * ⚠️ AND EVERY READ THROWS. The queue used to end in `(requests ?? [])` with the
 * error passed separately to the table; the detail page threw its errors away
 * entirely and rendered `notFound()` for a failed query, a deleted row and an
 * out-of-scope row alike. Both are fixed by the same rule: a failure lands in
 * `isError` and the page says so.
 * ------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* The queue.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * P7-64 — THE SORT ALLOWLIST, MOVED OUT OF THE PAGE.
 *
 * `?sort=` is a string somebody can type. It is narrowed to this closed union
 * and then used to pick a LITERAL `.order()` below — never interpolated into
 * one. An unknown column name reaches Postgres as `invalid input value` and 500s
 * the page, which is why every `.order()` in this repo names its column outright.
 */
export const REQUEST_SORTS = [
  "submitted",
  "reference",
  "title",
  "requester",
  "target",
  "agreed",
  "status",
] as const;
export type RequestSort = (typeof REQUEST_SORTS)[number];

export function isRequestSort(value: string | undefined): value is RequestSort {
  return typeof value === "string" && (REQUEST_SORTS as readonly string[]).includes(value);
}

/**
 * The order applied when the URL asks for none.
 *
 * Sorted newest first: this is an inbox, and the request somebody is chasing is
 * almost always the one that just landed. `requests-table.tsx` passes the same
 * pair to `DataTable` as `defaultSort`, which is the only reason its header can
 * draw an arrow for an order nobody put in the query string — change one and
 * change the other or it goes back to lying about it.
 */
export const DEFAULT_REQUEST_SORT = { sort: "submitted", ascending: false } as const;

const ORDER_COLUMN: Record<RequestSort, string> = {
  submitted: "submitted_at",
  reference: "reference_no",
  title: "title",
  requester: "requester_name",
  target: "target_date",
  agreed: "approved_target_date",
  status: "status",
};

export type RequestsParams = {
  term: string;
  status: VizservePmsRequestStatus | null;
  formId: string | null;
  from: string | null;
  to: string | null;
  page: number;
  pageSize: number;
  /** `undefined` when the URL named no sort we recognise. Decides whether `?dir=` is obeyed. */
  requestedSort: RequestSort | undefined;
  dir: string | undefined;
};

export type RequestsPage = {
  rows: RequestListRow[];
  total: number;
  /** Reviewer id → name, over the reviewers on THIS page only. */
  reviewerNames: Record<string, string>;
};

/**
 * `qk.requests(filters)` — one `.range()` of the Gate 1 queue, plus the names
 * for its Reviewed-by column.
 *
 * ⚠️ THE NAMES GENUINELY WAIT, and they are the only thing here that does. They
 * are keyed by the `reviewed_by` ids that come back on this page of rows, so
 * they cannot go in a parallel wave. The FORM list can and does — it takes
 * nothing from the results and was simply awaited after them, which cost a round
 * trip to answer an unrelated question.
 *
 * ⚠️ ONE `in` QUERY RATHER THAN AN EMBED. `reviewed_by` is null on every pending
 * row, so joining would widen the hot query to answer a question only the
 * decided rows ask.
 */
export async function fetchRequestsPage(
  client: TaskReadClient,
  params: RequestsParams,
): Promise<RequestsPage> {
  const sort: RequestSort = params.requestedSort ?? DEFAULT_REQUEST_SORT.sort;
  /* ONE SOURCE FOR THE DIRECTION. An explicit sort obeys `?dir=` — ascending
     unless it says otherwise, which is why the table leaves `asc` out of the URL
     — and no explicit sort takes the default's. Reading a column name back out
     of the URL to decide the direction, as this once did, meant the arrow and
     the rows could disagree and one column could never be reversed. */
  const ascending = params.requestedSort ? params.dir !== "desc" : DEFAULT_REQUEST_SORT.ascending;

  /*
   * P7-66 — REAL PAGING, REPLACING A SILENT CAP. This was `.limit(200)` with a
   * sentence under the table apologising for it. A queue that grows forever
   * cannot be capped and called complete: the 201st request simply did not exist
   * as far as this page was concerned, and sorting by target date made WHICH 200
   * you saw change under you.
   */
  const from = (params.page - 1) * params.pageSize;

  let query = client
    .from("vizserve_pms_requests")
    .select(
      "id, reference_no, title, requester_name, requester_org, target_date, approved_target_date, status, submitted_at, sla_started_at, reviewed_by, form_id",
      { count: "exact" },
    )
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    .range(from, from + params.pageSize - 1);

  /* Reference, title and requester — the three things somebody actually has to
     hand when chasing a request. `ilikeAnyOf` quotes the value; never build the
     filter string here. */
  const search = ilikeAnyOf(
    ["reference_no", "title", "requester_name", "requester_org"],
    params.term,
  );
  if (search) query = query.or(search);

  if (params.status) query = query.eq("status", params.status);
  if (params.formId) query = query.eq("form_id", params.formId);
  if (params.from) query = query.gte("submitted_at", params.from);
  // Inclusive of the end date: "to 3 Aug" means through 3 Aug, not up to its
  // first second.
  if (params.to) query = query.lt("submitted_at", `${params.to}T23:59:59.999Z`);

  /*
   * ⚠️ AWAITED DIRECTLY RATHER THAN THROUGH `read()`, BECAUSE IT CARRIES A
   * COUNT. `count: "exact"` returns `data` AND `count` from one round trip, and
   * `read()` hands back only the rows. The error is raised through `read()`
   * below anyway, so the message and the PostgREST code are shaped exactly like
   * every other failed read — `isPermanent()` keys on that code.
   */
  const { data, count, error } = await query;
  if (error) await read<unknown>(Promise.resolve({ data: null, error }));

  const rows = parseAll(requestListRowSchema, data ?? [], "requests");

  /* Names for the "Reviewed by" column, over the reviewers on this page only. */
  const reviewerIds = [...new Set(rows.map((row) => row.reviewed_by).filter(Boolean))] as string[];

  const reviewers =
    reviewerIds.length > 0
      ? await read<unknown[]>(
          client.from("vizserve_pms_users").select("id, full_name").in("id", reviewerIds),
        )
      : [];

  return {
    rows,
    total: count ?? 0,
    reviewerNames: Object.fromEntries(
      parseAll(reviewCandidateSchema.omit({ role: true }), reviewers, "reviewers").map((person) => [
        person.id,
        person.full_name,
      ]),
    ),
  };
}

/**
 * `qk.ref("client-forms")` — the filter dropdown's options and the SLA lookup.
 *
 * ⚠️ REFERENCE DATA, AND FILED AS SUCH RATHER THAN UNDER THE PAGE THAT ASKS FOR
 * IT. It is admin-managed, changes about as often as a department does, and is
 * read by the filter panel on every visit to this queue. `client.ts`'s
 * `REF_STALE_TIME` is where that belongs — the queue re-reads its rows on every
 * filter change and must not re-read the dropdown with them.
 *
 * ⚠️ `purpose` NARROWS THIS, AND IT IS NOT A DEPARTMENT FILTER IN DISGUISE. A
 * request can only come from a CLIENT_REQUEST form, so an internal form in this
 * picker is an option that can never match a row. It matters because `published
 * internal forms readable by their audience`
 * (20260902110000_p7_66_form_responses.sql) makes every published internal form
 * readable by every signed-in person — so without this line a lead would see
 * other departments' survey names listed as request filters. Client forms are
 * untouched by that policy and stay department-scoped by RLS.
 */
export async function fetchClientForms(client: TaskReadClient): Promise<RequestForm[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_forms")
      .select("id, name, sla_minutes")
      .eq("purpose", "CLIENT_REQUEST")
      .order("name"),
  );

  return parseAll(requestFormSchema, rows, "forms");
}

/* -------------------------------------------------------------------------- */
/* The detail page.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `qk.request(id)` — THE REQUEST ROW, WIDENED TO THE SUPERSET IT WAS PROMISED.
 *
 * ⚠️ THIS REPLACES `fetchTaskRequest` IN `fetchers/task.ts`, whose own comment
 * asked for exactly this: "Phase 4 moves `/requests/[id]` onto this key with a
 * far wider column set; whichever writes last wins the entry. Widen this one
 * then." `/tasks/[id]` now reads this same fetcher and takes the eleven fields
 * it wants; both surfaces share one entry, so opening a request from a task
 * costs nothing.
 *
 * ⚠️ A NULL ROW IS THE ORDINARY CASE, NOT A FAILURE — and it means two different
 * things depending on who is asking:
 *
 *   * On `/requests/[id]`: gone, or never yours. `requests readable in
 *     department scope` returns no row rather than a refusal, which the page
 *     turns into `notFound()` — the right thing to leak, because "exists but not
 *     for you" is itself information.
 *   * On `/tasks/[id]`: P7-59, and entirely expected. That policy returns NO ROW
 *     to a member PIC, deliberately — the client is never told who at VizServe
 *     holds their task, and the anonymity runs both ways.
 *
 * ⚠️ WHICH IS WHY IT MUST NOT BE FOLDED INTO `qk.task(id)`. Making the task
 * query's success depend on a read most of the team is refused would take the
 * whole page down for the very people the split exists to serve.
 */
export async function fetchRequestDetail(
  client: TaskReadClient,
  requestId: string,
): Promise<RequestDetail | null> {
  const row = await read<unknown>(
    client
      .from("vizserve_pms_requests")
      .select(
        "id, reference_no, title, description, requester_name, requester_email, requester_org, target_date, approved_target_date, field_values, status, decision_reason, submitted_at, sla_started_at, reviewed_by, reviewed_at, form_id",
      )
      .eq("id", requestId)
      .maybeSingle(),
  );

  return row === null ? null : parse(requestDetailSchema, row, "the request");
}

export type RequestContext = {
  form: RequestFormDetail | null;
  fields: RequestFormField[];
  attachments: RequestAttachment[];
};

/**
 * `qk.request(id)` + `"context"` — the form, its field labels and the files.
 *
 * ⚠️ A SEPARATE KEY SEGMENT FROM THE ROW, AND THE REASON IS WHAT CHANGES. The
 * request row moves at Gate 1: a decision writes `status`, `decision_reason`,
 * `approved_target_date`, `reviewed_by` and `reviewed_at` in one statement, and
 * `onSettled` refetches it. None of this moves at all — the form's name, its
 * field labels and the uploaded files are fixed the moment a client presses
 * Submit. Folding them into the row's key would refetch three queries on every
 * decision to re-learn three things that cannot have changed.
 *
 * They go out in ONE wave. All three are keyed by something already in hand: the
 * `id` from the URL, or the `form_id` off the row.
 *
 * ⚠️ ARCHIVED FIELDS ARE INCLUDED. A historical answer must keep rendering with
 * its label even after the field is retired from the live form (D20/R5).
 */
export async function fetchRequestContext(
  client: TaskReadClient,
  requestId: string,
  formId: string,
): Promise<RequestContext> {
  const [formRow, fieldRows, attachmentRows] = await Promise.all([
    read<unknown>(
      client
        .from("vizserve_pms_forms")
        .select("id, name, sla_minutes, department_id, default_list_id")
        .eq("id", formId)
        .maybeSingle(),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_form_fields")
        .select("field_key, label, field_type, is_active")
        .eq("form_id", formId)
        .order("sort_order"),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_request_attachments")
        .select("id, filename, mime_type, size_bytes, field_key")
        .eq("request_id", requestId)
        .order("created_at"),
    ),
  ]);

  return {
    form: formRow === null ? null : parse(requestFormDetailSchema, formRow, "the form"),
    fields: parseAll(requestFormFieldSchema, fieldRows, "the form's fields"),
    attachments: parseAll(requestAttachmentSchema, attachmentRows, "attachments"),
  };
}

export type RequestOutcome = {
  decisions: RequestDecision[];
  /** P7-59. Null on a returned or rejected request — those never become a task. */
  task: RequestLinkedTask | null;
  /** Names for the three people this card can mention. */
  names: Record<string, string>;
};

/**
 * `qk.request(id)` + `"outcome"` — what was decided, and where the work went.
 *
 * ⚠️ READ ONLY ONCE THERE IS A DECISION, exactly as the RSC's ternary arranged.
 * A pending request has no task by definition and no approval rows, and the RSC
 * already refused to pay for either on a request decided last week. The caller
 * gates this with `enabled`, so a pending request issues no query rather than
 * one it discards.
 *
 * NO DEPARTMENT FILTER ON THE TASK. The task policy is WIDER than the request
 * policy — a lead who can open this request necessarily manages the department
 * the task was created in — so RLS returning a row IS the permission check, and
 * restating it here would imply the policy were optional.
 */
export async function fetchRequestOutcome(
  client: TaskReadClient,
  requestId: string,
): Promise<RequestOutcome> {
  const [taskRow, decisionRows] = await Promise.all([
    read<unknown>(
      client
        .from("vizserve_pms_tasks")
        .select("id, title, status, assignee_id, qa_assignee_id")
        .eq("request_id", requestId)
        .maybeSingle(),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_approvals")
        .select("decision, reason, created_at, approver_id")
        .eq("entity_type", "request")
        .eq("entity_id", requestId)
        .order("created_at", { ascending: false }),
    ),
  ]);

  const task = taskRow === null ? null : parse(requestLinkedTaskSchema, taskRow, "the task");
  const decisions = parseAll(requestDecisionSchema, decisionRows, "the decision log");

  /*
   * ⚠️ ONE `in` QUERY RATHER THAN THREE JOINS. `approver_id` was already being
   * SELECTED by the decisions query and then never rendered, which is how
   * "Approved · 2 Sep" ended up not saying by whom (P7-59).
   *
   * ⚠️ AND NOT `qk.ref("users")`. The directory is the whole staff list under a
   * ten-minute stale time and is exactly the right home for the task pages,
   * which resolve dozens of names. This resolves at most three, on a page most
   * people open once — pulling the directory in would trade a two-row query for
   * the whole company on a screen that needs neither.
   */
  const peopleIds = [
    decisions[0]?.approver_id,
    task?.assignee_id,
    task?.qa_assignee_id,
  ].filter((value): value is string => Boolean(value));

  const people =
    peopleIds.length > 0
      ? await read<unknown[]>(
          client
            .from("vizserve_pms_users")
            .select("id, full_name")
            .in("id", [...new Set(peopleIds)]),
        )
      : [];

  return {
    decisions,
    task,
    names: Object.fromEntries(
      parseAll(reviewCandidateSchema.omit({ role: true }), people, "people").map((person) => [
        person.id,
        person.full_name,
      ]),
    ),
  };
}

export type ReviewContext = {
  candidates: ReviewCandidate[];
  capacity: CapacityRow[];
  lists: ReviewList[];
  /** P7-25. The department's reserved Client Requests folder, by its flag. */
  clientFolderId: string | null;
};

/**
 * `qk.request(id)` + `"review"` — everything the Gate 1 decision panel needs.
 *
 * ⚠️ LOADED ONLY WHEN THE PANEL WILL RENDER, and that gate is not an
 * optimisation. `vizserve_pms_department_capacity` is a scan over the
 * department's open tasks, and there is no reason to pay for it on a request
 * that was decided last week. The caller passes `enabled: awaitingDecision`, so
 * a decided request issues nothing at all.
 *
 * ⚠️ ALL FOUR ARE KEYED BY THE FORM'S `department_id`, which is why they are a
 * wave of their own rather than part of `fetchRequestContext` — the department
 * does not exist until the form has come back. That was true in the RSC too and
 * is the one genuine sequential dependency on this page.
 */
export async function fetchReviewContext(
  client: TaskReadClient,
  departmentId: string,
  targetDate: string | null,
): Promise<ReviewContext> {
  const [candidateRows, capacityRows, listRows, folderRow] = await Promise.all([
    read<unknown[]>(
      client
        .from("vizserve_pms_users")
        .select("id, full_name, role")
        .eq("primary_department_id", departmentId)
        .eq("is_active", true)
        .order("full_name"),
    ),

    read<unknown>(
      client.rpc("vizserve_pms_department_capacity", {
        p_department_id: departmentId,
        p_target_date: targetDate,
      }),
    ),

    read<unknown[]>(
      client
        .from("vizserve_pms_lists")
        .select("id, name")
        .eq("department_id", departmentId)
        .eq("is_active", true)
        .order("sort_order")
        .order("name"),
    ),

    /*
     * P7-25 — where a list created DURING the approval goes.
     *
     * Without this the inline creator called `saveList` with no `group_id` and
     * the list hung loose under the department — so a lead who made a list for a
     * piece of client work found it filed nowhere near the client work.
     *
     * The reserved folder, by its FLAG rather than by its name: the name is
     * refused a rename by trigger, but matching on a string would still be
     * matching on a label where a boolean exists.
     */
    read<unknown>(
      client
        .from("vizserve_pms_task_groups")
        .select("id")
        .eq("department_id", departmentId)
        .eq("is_system", true)
        .maybeSingle(),
    ),
  ]);

  return {
    candidates: parseAll(reviewCandidateSchema, candidateRows, "the department's people"),
    capacity: parseAll(capacityRowSchema, capacityRows ?? [], "the capacity panel"),
    lists: parseAll(reviewListSchema, listRows, "lists"),
    clientFolderId: (folderRow as { id: string } | null)?.id ?? null,
  };
}

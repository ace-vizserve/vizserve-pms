import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { read, ReadError } from "@/lib/query/read";
import {
  clientDecisionSchema,
  departmentListSchema,
  directoryPersonSchema,
  subtaskRowSchema,
  taskAttachmentRowSchema,
  taskCommentRowSchema,
  taskCoverageSchema,
  taskHistoryEntrySchema,
  taskRequestRowSchema,
  taskRowSchema,
  taskTimeTrackedSchema,
  type ClientDecision,
  type DepartmentList,
  type DirectoryPerson,
  type SubtaskRow,
  type TaskAttachmentRow,
  type TaskCommentRow,
  type TaskCoverage,
  type TaskHistoryEntry,
  type TaskRequestRow,
  type TaskRow,
} from "@/lib/schemas/task-detail";
import { parseTaskRequestBrief, type TaskRequestBrief } from "@/lib/schemas/tasks";

/**
 * P12-06 — the reads behind `/tasks/[id]`, one function per query key.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `app/(app)/tasks/[id]/page.tsx` awaited the task row and
 * then a twelve-entry `Promise.all` in a single RSC. One batch, one cache entry
 * — the route's own render — so posting a comment re-ran the history, the
 * directory, the subtasks, the attachments, the time rollup and the brief in
 * order to redraw a thread. The point of splitting it is stated in the plan and
 * is worth restating here: POSTING A COMMENT REFETCHES COMMENTS, NOT THE TASK.
 *
 * ⚠️ WHICH KEY OWNS WHICH READ IS A DECISION, NOT A NAMING EXERCISE, and each
 * one is argued at its function below. The three that are NOT obvious:
 *
 *   `people`     → `qk.ref("users")`. It is the whole active directory, not
 *                  this task's people. Filing it under a per-task key would
 *                  hold one copy of the staff list per task anybody opens.
 *   `decisions`  → `qk.taskPart(id, "history")`, sharing with the trail. The
 *                  two are read together and USED together — the client's name
 *                  is matched onto a history row by the timestamp the two
 *                  inserts share — so splitting them would be two keys that can
 *                  never legally disagree.
 *   `brief`      → folded into `qk.task(id)`. It is the task's own brief, takes
 *                  `p_task_id` and nothing else, and is what most people see
 *                  where the request row is refused to them.
 *
 * ⚠️ AND ONE READ DID NOT MOVE AT ALL: `fetchJoinedTaskIdSet` (P7-13/P7-43),
 * which answers "is this person on this task without being named in
 * `assignee_id`". That decides `viewer.isAssignee`, which is a SEAT, and seats
 * belong with `requireAuthContext()` on the server — authentication does not go
 * through the cache. It is also the read the plan flags as not splitting
 * cleanly: elsewhere it is `.in("task_id", taskIds)` across a whole list. On
 * this page it is one task, so the server resolves it to a boolean and passes
 * it down. See `page.tsx`.
 *
 * ------------------------------------------------------------------------
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER, and nothing here may start to. RLS is
 * the enforcement layer (CLAUDE.md): a query carrying no department filter is
 * correct, and adding one implies the policy is optional. The `.eq("task_id",
 * …)` filters below are about WHICH ROWS THIS PAGE WANTS, not about who may see
 * them.
 *
 * ⚠️ AND EVERY ONE OF THEM GOES THROUGH `read()`, WHICH THROWS. There is no
 * `?? []` in this file and there must never be one — see `lib/query/read.ts` for
 * the two shipped bugs that rule exists to prevent.
 */

/**
 * The narrowest client these fetchers need.
 *
 * ⚠️ `Pick`, NOT THE WHOLE `SupabaseClient`, AND NOT A HAND-ROLLED STRUCTURAL
 * TYPE EITHER. `lib/query/fetchers/snapshot.ts` writes its client shape out by
 * hand because it needs exactly one method with one argument; a PostgREST
 * BUILDER CHAIN cannot be described that way without either `any` or a
 * hand-copy of `PostgrestFilterBuilder` that would drift from the library on
 * its next minor. Deriving the two methods from the real client keeps the
 * generated column types — so a typo in a `.select()` string is a typecheck
 * failure here rather than an `undefined` in the browser — and still takes the
 * client as an ARGUMENT, which is the half that makes these testable with an
 * object literal and no mocking framework. The test casts its stub once, at the
 * boundary, rather than the source casting its data.
 */
export type TaskReadClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

/**
 * `qk.task(id)` — the task row, its brief and who is covering it.
 *
 * ⚠️ THREE READS UNDER ONE KEY, and the grouping is the argument for the key.
 * All three are properties of THIS task, all three are keyed on nothing but its
 * id, and all three change together when the task does — a Gate 1 approval
 * writes the task and settles the brief in one statement, and a leave request
 * that starts today changes the coverage on every task its owner holds. Three
 * keys would be three refetches with nothing to tell them apart.
 *
 * They go out in ONE wave, not in sequence. The brief and the coverage need only
 * the id from the URL, exactly as they did in the RSC batch this replaces.
 */
export type TaskDetail = {
  task: TaskRow;
  /** Null for internal work, and for a caller with no seat. Three reasons, one answer. */
  brief: TaskRequestBrief | null;
  coverage: TaskCoverage[];
};

export async function fetchTaskDetail(
  client: TaskReadClient,
  taskId: string,
): Promise<TaskDetail> {
  const [row, briefPayload, coverageRows] = await Promise.all([
    /*
     * ⚠️ `.maybeSingle()`, AND A NULL HERE IS NOT AN ERROR. Out of scope returns
     * no row under RLS rather than a refusal, so `null` means "gone or not
     * yours" — the same answer `page.tsx` turns into `notFound()` on the server
     * before this ever runs. If it comes back null in the browser the row was
     * deleted or moved out of scope while somebody had the page open, which is
     * a real event and gets its own sentence below rather than a blank task.
     */
    read<unknown>(
      client
        .from("vizserve_pms_tasks")
        .select(
          "id, title, description, status, resolution, output_link, due_date, start_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, is_personal, priority, estimate_minutes, field_values, created_by, created_at",
        )
        .eq("id", taskId)
        .maybeSingle(),
    ),

    /*
     * P7-59 — WHAT THE CLIENT ASKED FOR, WITHOUT WHO THEY ARE.
     *
     * ⚠️ THIS ONE READ IS DELIBERATELY TOLERANT OF FAILURE, and it is the only
     * exception in this file. `parseTaskRequestBrief` has always answered NULL
     * to three different questions — internal work, a task that does not exist,
     * and a caller with no seat — because the page does the same thing with all
     * three. The function is also a SECURITY DEFINER projection that deploys
     * separately from this code (CLAUDE.md: migrations are pasted by hand after
     * the code ships), so "the function is not there yet" is a routine, expected
     * state on a live day.
     *
     * Letting it throw would take the WHOLE TASK QUERY down for it — the title,
     * the status, the dates and the header — over a panel that is legitimately
     * absent for most readers anyway. So the failure is LOGGED, loudly, and
     * folded into the null the page already knows how to render. That is the
     * same call `lib/tasks-server.ts` makes for `fetchJoinedTaskIds` and for the
     * same stated reason: this read WIDENS what a page can show, and degrading
     * it shows somebody less than they should see, where throwing takes out the
     * page.
     */
    client
      .rpc("vizserve_pms_task_request_brief", { p_task_id: taskId })
      .then(({ data, error }) => {
        if (error) {
          console.error(
            `[task] request brief unavailable for ${taskId} — ${error.message} ` +
              `(code ${error.code ?? "none"}). The panel is hidden; the task still renders.`,
          );
          return null;
        }
        return data;
      }),

    /*
     * P9-01 — is somebody covering this task right now?
     *
     * The view already filters to APPROVED leave whose dates contain today in
     * Manila, so this is a lookup and not a date calculation. `security_invoker`,
     * so it is scoped by the policies on the tables beneath it — a reader who
     * cannot see the leave request gets no row, which is the right answer for a
     * request whose reason they have no business reading.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_active_task_coverage")
        .select("reliever_id, absent_user_id, end_date")
        .eq("task_id", taskId),
    ),
  ]);

  if (row === null) {
    /*
     * ⚠️ A SENTENCE, NOT AN EMPTY TASK. The server already 404'd anything RLS
     * hides before this component mounted, so reaching here means the row went
     * away underneath somebody — deleted, or moved to a department they are not
     * in. Rendering the page with every field blank would say the task is empty;
     * this says it is gone.
     */
    throw new ReadError(
      "That task is no longer there — it may have been deleted, or moved somewhere you cannot see.",
    );
  }

  return {
    task: parse(taskRowSchema, row, "task"),
    // Parsed by the schema that has always owned this payload. Null in, null out.
    brief: parseTaskRequestBrief(briefPayload),
    coverage: parseAll(taskCoverageSchema, coverageRows, "task coverage"),
  };
}

/**
 * `qk.taskPart(id, "history")` — the trail AND the client's decisions.
 *
 * ⚠️ ONE KEY FOR TWO TABLES, ON PURPOSE. The Activity feed is built by matching
 * `client_decisions.approver_name` onto a `task_status_history` row through the
 * timestamp the two share, because `vizserve_pms_decide_task` writes both in ONE
 * statement. Two keys would be two cache entries that can never legally
 * disagree and would routinely be refetched apart — one arriving without the
 * other renders the client's own words attributed to "The client" instead of to
 * the person who wrote them.
 *
 * Newest first, both of them: a task goes round Gate 3 more than once, and the
 * rail reports the most recent word.
 */
export type TaskHistory = {
  history: TaskHistoryEntry[];
  /** Empty on internal work — there is no client to have decided anything. */
  decisions: ClientDecision[];
};

export async function fetchTaskHistory(
  client: TaskReadClient,
  taskId: string,
  options: { hasRequest: boolean },
): Promise<TaskHistory> {
  const [historyRows, decisionRows] = await Promise.all([
    read<unknown[]>(
      client
        .from("vizserve_pms_task_status_history")
        .select("id, from_status, to_status, actor_id, comment, is_override, created_at")
        .eq("task_id", taskId)
        .order("created_at", { ascending: false }),
    ),

    /*
     * Only where there is a client. Scoped by the task's own policy (P4), so a
     * task out of scope has already 404'd on the server — this skips the round
     * trip rather than the check.
     */
    options.hasRequest
      ? read<unknown[]>(
          client
            .from("vizserve_pms_client_decisions")
            .select("id, decision, comment, approver_name, created_at")
            .eq("task_id", taskId)
            .order("created_at", { ascending: false }),
        )
      : Promise.resolve([]),
  ]);

  return {
    history: parseAll(taskHistoryEntrySchema, historyRows, "task history"),
    decisions: parseAll(clientDecisionSchema, decisionRows, "client decisions"),
  };
}

/**
 * `qk.taskPart(id, "comments")` — P7-08. Oldest first, which is reading order
 * for a conversation; the detail page reverses it for the feed itself.
 */
export async function fetchTaskComments(
  client: TaskReadClient,
  taskId: string,
): Promise<TaskCommentRow[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_task_comments")
      .select("id, body, author_id, created_at, updated_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true }),
  );

  return parseAll(taskCommentRowSchema, rows, "comments");
}

/**
 * `qk.taskPart(id, "subtasks")` — P7-28.
 *
 * ⚠️ THE ONE READ THE PLAN WARNS ABOUT, AND ON THIS PAGE IT SPLITS CLEANLY.
 * Subtasks are fetched `.in("task_id", taskIds)` on the LIST, across eighty
 * rows at once, which cannot be filed under a per-task key. Here it is
 * `.eq("parent_task_id", <this task>)` — one parent, one key, no overlap with
 * whatever `qk.taskList` ends up holding in Phase 3b.
 *
 * P7-09 is one level deep and trigger-enforced, so this is a single flat query.
 * Same order as the list's own groups: it is a queue, not a trail.
 */
export async function fetchSubtasks(
  client: TaskReadClient,
  taskId: string,
): Promise<SubtaskRow[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_tasks")
      .select("id, title, status, due_date, assignee_id, priority")
      .eq("parent_task_id", taskId)
      .order("created_at"),
  );

  return parseAll(subtaskRowSchema, rows, "subtasks");
}

/** `qk.taskPart(id, "attachments")` — the team's output files, oldest first. */
export async function fetchTaskAttachments(
  client: TaskReadClient,
  taskId: string,
): Promise<TaskAttachmentRow[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_task_attachments")
      .select("id, filename, mime_type, size_bytes, uploaded_by")
      .eq("task_id", taskId)
      .order("created_at"),
  );

  return parseAll(taskAttachmentRowSchema, rows, "output files");
}

/**
 * `qk.taskPart(id, "time")` — P7-15, minutes logged by EVERYONE.
 *
 * ⚠️ TIME TRACKED CANNOT BE A PLAIN SUM, and this is the trap `page.tsx` and
 * `tasks/page.tsx` both document at their own call sites.
 * `vizserve_pms_timesheet_entries`' SELECT policy is owner-or-their-lead, so a
 * member summing that table for this task would see only the hours THEY logged
 * and read it as the task total — two people on one task seeing two different
 * figures on the same screen, and their lead a third. The rollup is SECURITY
 * DEFINER for exactly that reason, and returns a row only for tasks the caller
 * may already see.
 *
 * ⚠️ NO ROW MEANS ZERO MINUTES, AND THAT IS NOT A `?? 0` ON A FAILURE. The RPC
 * takes and returns a SET, because it is the same rollup the list page calls for
 * eighty tasks at once; a task nobody has logged against is simply absent from
 * it. A failed read still throws out of `read()` above, which is the distinction
 * that matters.
 */
export async function fetchTaskTimeTracked(
  client: TaskReadClient,
  taskId: string,
): Promise<number> {
  const rows = await read<unknown[]>(
    client.rpc("vizserve_pms_task_time_tracked", { p_task_ids: [taskId] }),
  );

  const parsed = parseAll(taskTimeTrackedSchema, rows, "time tracked");
  return parsed.find((entry) => entry.task_id === taskId)?.minutes ?? 0;
}

/**
 * `qk.lists(departmentId)` — the department's active lists.
 *
 * ⚠️ FILED UNDER THE DEPARTMENT AND NOT UNDER THE TASK, because that is what it
 * is: every task in a department reads the same list, and a per-task key would
 * hold one copy per task anybody opens and refetch all of them when a list is
 * renamed.
 *
 * ⚠️ AND IT IS A NARROWER SHAPE THAN `/tasks/lists` WILL WANT. Phase 4 moves
 * `list-manager.tsx` onto this same key, and that screen needs folders, sort
 * order, ownership and the archived lists this one filters out. WHICHEVER
 * SHAPE IS WRITTEN LAST WINS THE CACHE ENTRY, silently, and the loser reads
 * `undefined` off a column it was promised — so when that lands, this fetcher
 * must be widened to the SUPERSET rather than left to race. Flagged here rather
 * than discovered there.
 *
 * Ordered by name, and no department filter beyond the one this page needs:
 * the `lists readable in department scope` policy is what decides visibility.
 */
export async function fetchDepartmentLists(
  client: TaskReadClient,
  departmentId: string,
): Promise<DepartmentList[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_lists")
      .select("id, name")
      .eq("department_id", departmentId)
      .eq("is_active", true)
      .order("name"),
  );

  return parseAll(departmentListSchema, rows, "lists");
}

/**
 * `qk.ref("users")` — every active person, for every name on the page.
 *
 * ⚠️ THIS IS REFERENCE DATA AND IT IS FILED AS SUCH, which is the one key on
 * this page that belongs to a later phase. The alternative was
 * `qk.taskPart(id, "assignees")`, and it is wrong twice: this is not the task's
 * assignees, it is the whole active directory, and filing it per task would
 * hold one copy of the staff list for every task open in the tab. `qk.ref` is
 * where `client.ts`'s `REF_STALE_TIME` already points, so Phase 6 inherits a
 * populated key rather than a duplicate to reconcile.
 *
 * The page uses it for three things: names beside history rows and subtasks,
 * the coverage sentence, and `departmentPeople` — the reassign candidates,
 * filtered to the task's own department because that is the set `reassignTask`
 * and `quickAddTask` will accept. Offering anybody else is offering a door the
 * server does not open.
 */
export async function fetchActiveUsers(client: TaskReadClient): Promise<DirectoryPerson[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_users")
      .select("id, full_name, primary_department_id")
      .eq("is_active", true)
      .order("full_name"),
  );

  return parseAll(directoryPersonSchema, rows, "people");
}

/**
 * `qk.request(requestId)` — P7-59, THE LEAD'S VIEW AND ONLY THE LEAD'S.
 *
 * ⚠️ A NULL ROW IS THE ORDINARY CASE, NOT A FAILURE. `requests readable in
 * department scope` returns NO ROW to a member PIC, deliberately: the client is
 * never told who at VizServe holds their task, and the anonymity runs both
 * ways. Everything the person doing the work needs comes from the brief on
 * `qk.task(id)` — this is the IDENTITY plus Gate 1, and nothing else.
 *
 * ⚠️ FILED UNDER THE REQUEST'S OWN ID RATHER THAN FOLDED INTO `qk.task(id)`,
 * and the reason is the policy. Folding a LEAD-ONLY read into the task key would
 * make the task query's success depend on a read most of the team is refused —
 * and a refusal that arrives as an error, rather than as a null row, would take
 * the whole page down for the very people the split exists to serve.
 *
 * ⚠️ SAME SUPERSET WARNING AS `fetchDepartmentLists`. Phase 4 moves
 * `/requests/[id]` onto this key with a far wider column set; whichever writes
 * last wins the entry. Widen this one then.
 */
export async function fetchTaskRequest(
  client: TaskReadClient,
  requestId: string,
): Promise<TaskRequestRow | null> {
  const row = await read<unknown>(
    client
      .from("vizserve_pms_requests")
      .select(
        "id, reference_no, requester_name, requester_email, requester_org, description, target_date, submitted_at, reviewed_by, reviewed_at, form_id",
      )
      .eq("id", requestId)
      .maybeSingle(),
  );

  if (row === null) return null;
  return parse(taskRequestRowSchema, row, "the request");
}

/* -------------------------------------------------------------------------- */
/* The parse boundary.                                                         */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ ONE PLACE THE PARSE FAILURE IS TURNED INTO A SENTENCE, so every fetcher
 * above reports a shape mismatch the same way and none of them is tempted to
 * cast instead.
 *
 * NO POSTGREST CODE IS INVENTED FOR IT — `snapshot.ts` argues this at length.
 * `isPermanent()` keys on the `42xxx` family because those are genuinely
 * "permission denied for table …"; borrowing one to buy a skipped retry would
 * make the retry policy lie about what happened. So a shape fault retries twice
 * like any other transient failure and then lands in `isError`, where it
 * belongs.
 */
function parse<T>(schema: { safeParse: (value: unknown) => SafeParse<T> }, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new ReadError(
    `${what} came back in a shape this build does not recognise. If a migration has ` +
      `not been applied to this project yet, that is why.`,
    undefined,
    parsed.error.message,
  );
}

function parseAll<T>(
  schema: { safeParse: (value: unknown) => SafeParse<T> },
  rows: unknown,
  what: string,
): T[] {
  if (!Array.isArray(rows)) {
    throw new ReadError(`${what} came back as something other than a list of rows.`);
  }
  return rows.map((row) => parse(schema, row, what));
}

/** The half of zod's result these two helpers actually read. */
type SafeParse<T> =
  | { success: true; data: T }
  | { success: false; error: { message: string } };

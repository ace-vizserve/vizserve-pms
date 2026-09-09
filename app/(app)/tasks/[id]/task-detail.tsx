"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import Link from "next/link";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RichTextClient } from "@/components/ui/rich-text-client";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchDirectory,
  fetchSubtasks,
  fetchTaskAttachments,
  fetchTaskComments,
  fetchTaskDetail,
  fetchTaskHistory,
  fetchTaskRequest,
  fetchTaskTimeTracked,
  fetchVisibleLists,
} from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";
import { richTextToPlainText } from "@/lib/rich-text";
import { cn } from "@/lib/utils";
import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";
import { TASK_STATUS_LABELS, availableTransitions, isTerminal, taskCategory } from "@/lib/schemas/tasks";

import { CommentThread, type TaskActivityEvent } from "../comment-thread";
import { AddSubtask } from "../inline";

import { RequestAttachmentList } from "./client-files";
import { TaskDetailSkeleton } from "./detail-skeleton";
import { ACTION_LINK, TASK_DETAIL_GRID } from "./grid";
import { GateTrack } from "./lifecycle-rail";
import { SubtaskList } from "./subtask-list";
import { TaskGateProvider } from "./task-gate";
import { TaskHeader } from "./task-header";
import { TaskOutputs } from "./task-outputs";
import { TaskSurface } from "./task-surface";

/**
 * P3-05 / P12-06 — task detail, reading from the cache instead of the server.
 *
 * The QA screen (P3-08) is this page seen by the QA reviewer, not a separate
 * one. The reviewer needs exactly what the PIC had — the original request's
 * fields, the resolution, the output — and building a second screen to show the
 * same things is how the two drift until QA is reviewing against a stale copy.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was one `Promise.all` of twelve queries in an RSC, behind one cache entry
 * — the route's own render. Posting a comment therefore re-ran the history, the
 * staff directory, the subtasks, the attachments, the time rollup and the brief
 * in order to redraw a thread. The reads are now nine query keys
 * (`lib/query/fetchers/task.ts` argues which key owns which read), so POSTING A
 * COMMENT REFETCHES COMMENTS.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireAuthContext()` — the
 * temporary-password wall, the `app_access` gate, the deactivation check — runs
 * in `page.tsx` beside it, before anything here mounts, and the `notFound()`
 * scope check runs there too so that a task RLS hides still reaches
 * `app/(app)/not-found.tsx`. Everything derived from the auth context arrives
 * here as `seat`, computed on the server. No decision about what somebody may
 * see is made in this file.
 *
 * ⚠️ AND THE SHARED CONTROLS NO LONGER CALL `router.refresh()`.
 * `transition.tsx`, `inline.tsx`, `assignees.tsx`, `delete-task-dialog.tsx` and
 * `task-composer.tsx` are rendered by the list and the board as well as by this
 * page, and while those two still read in RSC each control did BOTH — a refresh
 * for them and an invalidation for this page. P12-07 moved them onto the cache
 * and P12-09 removed the refresh: one mechanism, and the AWAITED invalidate in
 * `lib/query/invalidate.ts` is what now holds an optimistic value across the
 * settle. `ded2244` is what happened when the refresh came out with nothing in
 * its place; do not remove the await.
 * ------------------------------------------------------------------------
 */

/**
 * Everything about the reader that this page may not work out for itself.
 *
 * ⚠️ COMPUTED ON THE SERVER, WHERE `requireAuthContext()` IS. Every field here
 * is a ROLE or DEPARTMENT decision — `roleAtLeast`, `managedDepartmentIds`,
 * `canAdminDepartment`, and the P7-13/P7-43 join-table seat — and none of them
 * belongs in the browser. What this component derives from it is only the two
 * COLUMN comparisons, `assignee_id === me` and `qa_assignee_id === me`, which
 * have to follow the live row so that a reassignment repaints the controls
 * without waiting for a server render.
 *
 * `viewer` is presentation only either way (`lib/schemas/tasks.ts` says so in
 * capitals): hiding a control protects nobody, and every rule here is re-checked
 * in `vizserve_pms_transition_task` and in both tasks policies.
 */
/**
 * How many History rows a collapsed panel shows.
 *
 * Twelve, because a task that has been round QA twice is already about that
 * long — so the common case shows the WHOLE trail and the button never appears.
 * It is a ceiling on the pathological task, not a default that hides the
 * ordinary one.
 */
const HISTORY_COLLAPSED = 12;

export type TaskSeat = {
  userId: string;
  /**
   * P7-13 / P7-43 — this person is on the task WITHOUT being named in
   * `assignee_id`: a row in `vizserve_pms_task_assignees`.
   *
   * ⚠️ RESOLVED TO A BOOLEAN ON THE SERVER, AND THAT IS WHY THIS READ NEVER
   * BECAME A QUERY KEY. Elsewhere it is `.in("task_id", taskIds)` across a whole
   * list, which does not split into per-task keys at all. Here it is one task,
   * so `fetchJoinedTaskIdSet(...).has(id)` answers it once beside the auth
   * context and travels as a flag.
   */
  joined: boolean;
  leadsDepartment: boolean;
  isAdmin: boolean;
  /** P11-05 — an active member whose primary department is this task's. */
  inDepartment: boolean;
  /** P8-01c — holds the Admin tick on THIS task's department. */
  administersDepartment: boolean;
};

export function TaskDetail({
  taskId,
  seat,
  realtimeFilter,
}: {
  taskId: string;
  seat: TaskSeat;
  /** `realtimeDepartmentFilter(context)`, computed on the server with the rest. */
  realtimeFilter: string | null;
}) {
  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie` — which is why
   * that helper is lazy, and why calling it up here would move that reach into
   * the server pass. A `queryFn` only ever runs in the browser.
   * `sidebar-snapshot.tsx` states the same rule at its own call.
   */

  /*
   * ⚠️ THE TASK ROW THROWS TO THE BOUNDARY; EVERY PANEL REPORTS ITSELF.
   *
   * `throwOnError` here and nowhere else, and the split is the one the phase
   * brief asks to be stated. Without the task row there is no page — no title,
   * no status, no category, nothing for the header to be about — so a failure is
   * a failure of the whole screen and belongs in `app/(app)/error.tsx`, which
   * P12-05 added for exactly this. Before that boundary existed, letting a read
   * throw was not a legal option in this codebase and every fix had to be a
   * returned state.
   *
   * The panels are the opposite case. A history read that times out must not
   * take the brief, the resolution and the output files down with it — those are
   * separately useful, and `components/query-error.tsx` is the pattern of record
   * for saying "this did not load" in the space the panel would have occupied.
   * The old page contained the string "error" ZERO times across ~900 lines; that
   * is the gap being closed.
   */
  const taskQuery = useQuery({
    queryKey: qk.task(taskId),
    queryFn: () => fetchTaskDetail(browserClient(), taskId),
    throwOnError: true,
  });

  const task = taskQuery.data?.task;
  const brief = taskQuery.data?.brief ?? null;
  const coverage = taskQuery.data?.coverage ?? [];

  const hasRequest = Boolean(task?.request_id);

  /*
   * ⚠️ THE AUDIT LOG IS THE ONE PANEL WITH NO CEILING. Ace, 9 Sep. Every move a
   * task ever made is a row, and unlike Activity or the comment thread it never
   * stops growing — a task that has been round QA a few times runs past a
   * screenful, and the cards below it get pushed off the page for somebody who
   * only wanted the last three moves.
   *
   * A "Show more" button rather than paging. Paging an audit trail is the wrong
   * shape: there is no page anybody wants to be on, the interesting rows are
   * always the newest, and a reader who genuinely needs the whole thing wants it
   * as one column they can scroll and search with the browser — not eight at a
   * time with the trail broken across boundaries.
   *
   * Collapsed state only. It resets when the panel unmounts, which is right for
   * a log: expanding it is a thing you do to answer one question, not a
   * preference about how you read every task.
   */
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const historyQuery = useQuery({
    queryKey: qk.taskPart(taskId, "history"),
    queryFn: () => fetchTaskHistory(browserClient(), taskId, { hasRequest }),
    // ⚠️ NOT MERELY AN OPTIMISATION. `hasRequest` decides whether the decisions
    // half of this fetcher runs at all, so firing before the task row is back
    // would cache a history built on `hasRequest: false` for a client task —
    // the Gate 3 replies would be attributed to "The client" rather than to the
    // person who wrote them, and nothing would refetch it.
    enabled: Boolean(task),
  });

  const commentsQuery = useQuery({
    queryKey: qk.taskPart(taskId, "comments"),
    queryFn: () => fetchTaskComments(browserClient(), taskId),
  });

  const subtasksQuery = useQuery({
    queryKey: qk.taskPart(taskId, "subtasks"),
    queryFn: () => fetchSubtasks(browserClient(), taskId),
  });

  const attachmentsQuery = useQuery({
    queryKey: qk.taskPart(taskId, "attachments"),
    queryFn: () => fetchTaskAttachments(browserClient(), taskId),
  });

  const timeQuery = useQuery({
    queryKey: qk.taskPart(taskId, "time"),
    queryFn: () => fetchTaskTimeTracked(browserClient(), taskId),
  });

  /*
   * The staff directory, under `qk.ref("users")` rather than a per-task key —
   * see `fetchDirectory`. Every task open in the tab shares this one entry, and
   * so do `/tasks` and `/tasks/board`.
   */
  const peopleQuery = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
  });

  /*
   * ⚠️ EVERY VISIBLE LIST, NARROWED HERE RATHER THAN IN THE QUERY (P12-07).
   *
   * This was `qk.lists(task.department_id)` with a department filter in SQL, and
   * its own comment warned that the shape was narrower than the next consumer
   * would want and that whichever fetcher wrote the entry last would win it
   * silently. `/tasks` was that consumer: it needs the lists of every department
   * the reader can see, which is not a subset of any single department-keyed
   * entry. So the fetcher was widened to the genuine superset and the KEY moved
   * with it, and this page — which wants a subset — filters. One entry per tab
   * instead of one per department anybody opens.
   */
  const listsQuery = useQuery({
    queryKey: qk.listsVisible(),
    queryFn: () => fetchVisibleLists(browserClient()),
  });

  /*
   * P7-59 — the request row, and a null is the ORDINARY case rather than a
   * failure: `requests readable in department scope` returns no row to a member
   * PIC, deliberately.
   */
  const requestQuery = useQuery({
    queryKey: qk.request(task?.request_id ?? ""),
    queryFn: () => fetchTaskRequest(browserClient(), task!.request_id!),
    enabled: hasRequest,
  });

  /*
   * ⚠️ `isPending` IS "NO DATA YET", NOT "FETCHING". A background refetch over
   * data we already have must NOT throw the page away and redraw a skeleton,
   * which is the flicker the whole cache exists to remove. Same call
   * `sidebar-snapshot.tsx` makes for the rail.
   *
   * `role="status"` with a label because a Suspense-style placeholder rendered
   * INSIDE a page is announced by nothing at all — unlike `loading.tsx`, which
   * the router announces. The bars themselves stay `aria-hidden`; the label is
   * what speaks. See the note at the foot of `components/skeletons.tsx`.
   */
  /*
   * ⚠️ THE DIRECTORY IS PART OF THE FIRST PAINT, AND THAT IS NOT A PRELOADING
   * PREFERENCE. Every name on this page is resolved through `nameOf`, and the
   * one that matters is the PIC: `TaskSurface` renders a missing name as
   * "Unassigned", which is a STATEMENT ABOUT THE TASK rather than a gap. Drawing
   * the page before the people are back would tell somebody their task has
   * nobody on it for as long as that query takes — the same class of lie as a
   * count of zero over a failed read (P12-01), and the reason the whole phase
   * exists.
   *
   * It costs nothing after the first page: `qk.ref("users")` is shared by every
   * task in the tab and carries `REF_STALE_TIME`. And the two queries fire in
   * parallel, so this waits on the slower of the two rather than on both in
   * turn. An ERROR here is not pending — the strip below reports it and the page
   * draws.
   */
  if (taskQuery.isPending || peopleQuery.isPending || !task) {
    return (
      <PageShell className="gap-3">
        <div role="status" aria-label="Loading this task" className="contents">
          <TaskDetailSkeleton />
        </div>
      </PageShell>
    );
  }

  const request = requestQuery.data ?? null;
  const history = historyQuery.data?.history ?? [];
  const decisions = historyQuery.data?.decisions ?? [];
  const commentRows = commentsQuery.data ?? [];
  const children = subtasksQuery.data ?? [];
  const outputs = attachmentsQuery.data ?? [];
  const lists = (listsQuery.data ?? []).filter((list) => list.department_id === task.department_id);
  const people = peopleQuery.data ?? [];

  /*
   * P7-56 — COMPARE PROSE, NOT MARKUP.
   *
   * Both columns are rich text now, and two documents saying the same sentence
   * can differ by a wrapping tag alone. Comparing the HTML would open the
   * "As they wrote it" panel on tasks whose brief nobody has touched, and the
   * panel exists precisely to say that somebody HAS.
   */
  const briefDiffers = Boolean(
    brief?.description && richTextToPlainText(brief.description) !== richTextToPlainText(task.description ?? ""),
  );

  const nameOf = new Map(people.map((person) => [person.id, person.full_name]));

  /*
   * ⚠️ NULL, NOT ZERO, WHEN THE ROLLUP DID NOT COME BACK. `trackedMinutes`
   * renders as "6h logged" beside the estimate, and a failed read rendered as
   * `0` is the P12-01 bug in miniature: it says nobody has logged time against
   * this task, which on a task somebody has spent two days on is a lie nobody
   * would think to report. `TaskSurface` draws the null as "not available".
   *
   * A task nobody has logged against is genuinely absent from the RPC's result
   * set and comes back as `0` — that path is inside the fetcher, above `read()`,
   * and is a real zero.
   */
  const trackedMinutes = timeQuery.isError ? null : (timeQuery.data ?? 0);

  // Newest first out of the query, so the first row is the client's most recent
  // word — a task can carry a REVISION_REQUESTED and then an APPROVED.
  const latestDecision = decisions[0] ?? null;

  const category = taskCategory({
    request_id: task.request_id,
    is_personal: task.is_personal,
  });

  /*
   * P7-57 — THE ACTIVITY FEED: everything that was SAID on this task.
   *
   * A QA reviewer sending work back and a client asking for changes are the two
   * entries a PIC opens this page to find, and neither was a comment — both are
   * `task_status_history` rows carrying their note in `comment`. They rendered
   * only in the trail, one line among a dozen moves, indistinguishable from
   * "Open → Ongoing".
   *
   * ⚠️ ONLY ROWS THAT CARRIED WORDS. A plain move stays in History alone;
   * drawing every move in both panels is one fact drawn twice, which is not
   * emphasis but noise.
   *
   * ⚠️ AND THE CLIENT'S WORDS COME FROM HISTORY, NOT FROM `client_decisions`.
   * `vizserve_pms_decide_task` writes both in ONE statement — a history row with
   * the client's comment, and a decisions row with the same comment plus the
   * approver's name — so reading both would print what the client said twice.
   * The decisions table is used here for the NAME and nothing else, matched on
   * the timestamp the two inserts share because they are the same transaction.
   * That is also why the two share ONE query key: split apart they could arrive
   * out of step, and this map would silently miss.
   * `actor_id` is deliberately NULL on those rows: the client is a real actor
   * with no user row, and attributing their decision to whoever happened to be
   * signed in would be a lie in the one record a dispute turns on.
   */
  const clientNameAt = new Map(decisions.map((decision) => [decision.created_at, decision.approver_name]));

  const activity: TaskActivityEvent[] = history
    /*
     * ⚠️ AND NOT A FORCED MOVE. `overrideTaskStatus` also writes a comment — the
     * reason a lead gave for skipping the stages — but that is an audit record,
     * not something said to the team. It stays in History, where the "Forced"
     * chip beside it is the point, and where an override that reads like an
     * ordinary entry is an override that destroys the trail it appears in.
     */
    .filter((entry) => entry.comment && !entry.is_override)
    .map((entry) => {
      const returnedByClient = entry.from_status === "FOR_CLIENT_APPROVAL";
      const returnedByQa =
        (entry.from_status === "FOR_QA" || entry.from_status === "QA_IN_PROGRESS") && entry.to_status === "ONGOING";

      const kind = returnedByClient ? "client" : returnedByQa ? "qa" : "note";

      return {
        id: entry.id,
        kind,
        who: returnedByClient
          ? (clientNameAt.get(entry.created_at) ?? "The client")
          : entry.actor_id
            ? (nameOf.get(entry.actor_id) ?? "Someone no longer active")
            : "System",
        whoId: returnedByClient ? null : entry.actor_id,
        at: entry.created_at,
        from: entry.from_status ? TASK_STATUS_LABELS[entry.from_status] : null,
        to: TASK_STATUS_LABELS[entry.to_status],
        /*
         * ⚠️ SANITISED HERE, WHERE THE ROW IS READ, AND IT USED TO BE THE
         * SERVER DOING IT. `comment-thread.tsx` is `"use client"` and paints
         * this string with `dangerouslySetInnerHTML`; its own note says the
         * markup is trusted "because of where it came from", and where it comes
         * from is this line. The read moved to the browser, so the pass moved
         * with it — see `lib/rich-text-dom.ts` for why dropping it was not an
         * option.
         */
        said: entry.comment ? sanitizeRichTextInBrowser(entry.comment) : null,
      } satisfies TaskActivityEvent;
    });

  /*
   * THE ONE ENTRY STILL WAITING ON SOMEBODY, and only one.
   *
   * A task can carry three QA returns and two client revisions over its life and
   * every one stays in the feed, but only the most recent is a thing anybody has
   * to act on — marking them all would make the live one invisible among its own
   * history. The emphasis also disappears the moment the task leaves ONGOING,
   * because at that point the work has moved on and the return is just a record.
   *
   * `history` comes back newest-first, so the first match IS the most recent.
   */
  const live =
    task.status === "ONGOING"
      ? (activity.find((entry) => entry.kind === "qa" || entry.kind === "client")?.id ?? null)
      : null;

  for (const entry of activity) entry.live = entry.id === live;

  const viewer = {
    /*
     * P7-13 / P7-43 — the column OR the join table, mirroring
     * `vizserve_pms_transition_task`'s `v_is_pic` and both tasks policies.
     *
     * This page gates canEdit, canAdd and canUpload on it, so while it was the
     * column alone a second assignee opened the task they had been handed and
     * found it read-only — no edits, no attachments, no comments — on work the
     * database would have let them do all three to.
     *
     * ⚠️ THE COLUMN HALF IS READ OFF THE LIVE ROW, the join-table half off
     * `seat`. That is the split described on `TaskSeat`: a reassignment repaints
     * the controls from the cache, and every role/department decision stays on
     * the server where the auth context is.
     */
    isAssignee: task.assignee_id === seat.userId || seat.joined,
    isQa: task.qa_assignee_id === seat.userId,
    leadsDepartment: seat.leadsDepartment,
    isAdmin: seat.isAdmin,
    /*
     * P11-05 — an active member of THIS task's department.
     *
     * Mirrors `v_in_dept` in `vizserve_pms_transition_task` and the clause
     * P11-03 added to both tasks policies.
     */
    inDepartment: seat.inDepartment,
    /*
     * P8-01c — the Admin tick on THIS task's department, which is what
     * `vizserve_pms_force_task_status` now also accepts.
     *
     * Beside `leadsDepartment` rather than inside it: that flag is this page's
     * approval-shaped permission and gates renaming, editing, uploading and
     * reassigning. The tick confers none of those — only the force-status link.
     */
    administersDepartment: seat.administersDepartment,
  };

  const late = isOverdue(task.due_date) && !isTerminal(task.status);

  /**
   * On the task, leading it, or IN ITS DEPARTMENT. The single test behind
   * renaming, editing every field, uploading an output and adding a subtask —
   * it was spelled out four times in the JSX and drifted once already.
   *
   * P11-05 added the third clause. P11-03 had opened all of this in the
   * database a day earlier; until now the screen still hid it, so a colleague
   * who could legally fix a wrong due date opened the task and found it
   * read-only. A permission nobody can reach is not a permission.
   */
  const canWork = viewer.isAssignee || viewer.isQa || viewer.leadsDepartment || viewer.inDepartment;

  /**
   * Who this work can be given to. The department's own people, which is the
   * same set `reassignTask` and `quickAddTask` will accept — offering anybody
   * else is offering a door the server does not open.
   */
  const departmentPeople = people
    /* ⚠️ `is_active` IS TESTED HERE AND NOT IN THE QUERY (P12-07). `qk.ref("users")`
       holds the WHOLE directory now, because the people who leave are exactly the
       ones whose old comments and history rows still need a name — so every
       consumer that offers somebody a SEAT filters for itself, and this is one.
       Offering a deactivated colleague is offering a door `reassignTask` does not
       open. */
    .filter((person) => person.is_active && person.primary_department_id === task.department_id)
    .map((person) => ({ id: person.id, full_name: person.full_name }));

  return (
    // Full width, like the list pages. The old `max-w-4xl` centred a column and
    // left a third of a wide screen empty on either side.
    <PageShell className="gap-3">
      {/*
        P8-03 — the detail page follows the task while two people are on it.

        ⚠️ THE SUBSCRIPTION IS DEPARTMENT-WIDE, NOT `id=eq.<this task>`, and
        that is deliberate. A per-task filter would be tighter and would
        miss the things this page actually renders from OTHER rows — the
        subtask list is tasks, and a subtask changing status changes the
        progress bar here. One channel shape across all four pages also
        means one thing to reason about rather than four.

        ⚠️ P12-06 IS WHERE THIS STARTED PAYING AGAIN. P12-02 swapped the
        ping's reaction from `router.refresh()` to invalidating `qk.tasks()`
        and `qk.snapshot()`, and wrote down honestly that a page still reading
        in RSC would stop repainting on somebody else's write. This page reads
        `qk.task(id)` and its parts, so the invalidation reaches it — which is
        why P12-09 could take the hook's refresh away once the list and the
        board moved too. A colleague's edit lands here through the key, not
        through a route render.
      */}
      <RealtimeTasks filter={realtimeFilter} />

      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={task.title} />

      <Link
        href={`/tasks?list=${task.list_id}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        All tasks
      </Link>

      {/*
        ⚠️ THE DIRECTORY FAILING IS NOT "NOBODY IS ASSIGNED", AND WITHOUT THIS
        LINE IT WOULD LOOK EXACTLY LIKE IT.

        `nameOf` is how the PIC, the QA reviewer, every history row, every
        subtask and the coverage sentence get a name. When that one read fails,
        every one of those falls back to "Someone no longer active" or drops out
        — a page that reads as an unstaffed task rather than a broken query. The
        counts in the rail had the same failure mode and P12-01 answered it the
        same way: say so, rather than print something nobody can stand behind.

        A strip rather than a `QueryError` block: this does not take a panel
        away, it degrades every panel slightly, so it belongs above all of them.
      */}
      {peopleQuery.isError ? (
        <p role="alert" className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          Names could not be loaded, so people on this page are shown as unnamed. Nobody has been unassigned — this is a
          fault. {peopleQuery.error.message}
        </p>
      ) : null}

      {/*
        P7-57 — THE GATE STATE IS SHARED, and this is the reason for the wrapper.

        "Send for QA" is refused by the database while the resolution is empty.
        The button is in the header now and the field is in the surface below, so
        the two are separate trees and neither can hold the other's state.
        `TaskGateProvider` holds it: the surface pushes the saved value and its
        autosave flush, the header reads them. See `task-gate.tsx`.

        ⚠️ IT IS SEEDED ONCE, FROM THE FIRST PAYLOAD. `useState(resolution)` in
        the provider ignores later props, which is correct — the surface's own
        textarea is the live value from then on and a refetch must not reach in
        and replace what somebody is typing. `key` is deliberately NOT set to the
        resolution: remounting the provider on every save would clear the
        registered autosave flush and take the P3-07 keyboard path with it.
      */}
      <TaskGateProvider resolution={task.resolution ?? ""}>
        <TaskHeader
          taskId={task.id}
          title={task.title}
          status={task.status}
          // ⚠️ `category`, NEVER whether `request` came back. The requests policy
          // is not the tasks policy, so a PIC can hold a client task whose
          // originating request they cannot open — deciding the KIND from a null
          // row mislabels the task and hides Gate 3.
          category={category}
          viewer={viewer}
          task={{ request_id: task.request_id, is_personal: task.is_personal }}
          // NOT gated on `isTerminal`. The list row's rename is not either, and a
          // task you can rename from the list but not from its own page is the
          // kind of difference nobody reports and everybody works around.
          canEdit={canWork}
          listName={lists.find((list) => list.id === task.list_id)?.name ?? null}
          dueDate={task.due_date}
          late={late}
        />

        {/*
          P9-01 — WHO IS HOLDING THIS WHILE SOMEBODY IS AWAY.

          Coverage is derived, not stored: `vizserve_pms_active_task_coverage`
          answers it from the approved leave dates, so this appears on the first
          morning of the leave and is gone the day after the last without
          anything being run. `assignee_id` is untouched throughout — the person
          on leave still owns this task, and the badge says who is minding it.

          Above the fold, beside the status, because "the person whose name is on
          this is away until Friday" is the single most useful thing a reader can
          learn here and is invisible everywhere else.
        */}
        {coverage.length > 0 ? (
          <p className="rounded-sm border border-info/30 bg-info-subtle px-3 py-2 text-xs">
            {coverage.map((row) => (
              <span key={row.reliever_id}>
                Covered by <span className="font-medium">{nameOf.get(row.reliever_id) ?? "a colleague"}</span> until{" "}
                {formatDate(row.end_date)}, while {nameOf.get(row.absent_user_id) ?? "the assignee"} is on leave.
              </span>
            ))}
          </p>
        ) : null}

        {/*
          WHERE THE TASK IS — across the top, above both columns, and NOT in the
          History card where it used to sit.

          They are different questions drawn as one object: this is a ROUTE with
          fixed stops whose order is the pipeline, and History is a LOG ordered by
          time, newest first. A pipeline directly above a reverse-chronological
          list made the first look like the beginning of the second. It is up here
          because "how far along is this" is a header fact — it belongs beside the
          status chip and the button that moves it.
        */}
        <Card size="sm" className="py-0">
          <GateTrack
            status={task.status}
            category={category}
            createdAt={task.created_at}
            createdByName={task.created_by ? (nameOf.get(task.created_by) ?? null) : null}
            picName={task.assignee_id ? (nameOf.get(task.assignee_id) ?? null) : null}
            qaName={task.qa_assignee_id ? (nameOf.get(task.qa_assignee_id) ?? null) : null}
            /*
              P7-59 — DATED FROM THE BRIEF, NAMED FROM THE ROW.

              `submitted_at` is on both, and taking it from the brief is what
              makes "Requested · 1 Sept" render for a member PIC instead of a
              bare stage label. The requester's name and the Gate 1 reviewer come
              from the request row, which only a department lead can read, so
              they are null for everybody else and `line()` simply drops them.
            */
            request={
              brief || request
                ? {
                    submittedAt: brief?.submitted_at ?? request?.submitted_at ?? null,
                    requesterName: request?.requester_name ?? null,
                    reviewedAt: request?.reviewed_at ?? null,
                    reviewedByName: request?.reviewed_by ? (nameOf.get(request.reviewed_by) ?? null) : null,
                  }
                : null
            }
            decision={
              latestDecision
                ? {
                    decision: latestDecision.decision,
                    createdAt: latestDecision.created_at,
                    approverName: latestDecision.approver_name,
                  }
                : null
            }
          />
        </Card>

        {/*
        Two columns from `lg` up. THE LEFT IS THE TASK — its details, then the
        work — because a task is one thing and was being drawn as five competing
        panels. The right is the two logs, with no upper bound: a task round QA
        three times carries twenty history rows and a busy one carries forty
        comments, and in a single stack both sat between the work and the end of
        the page.

        Activity sits ABOVE History because one is a thing you take part in and
        the other is a thing you consult.

        The template lives in `grid.ts`, shared with `loading.tsx` — see the
        note there for why the skeleton must not carry its own copy of it.
      */}
        <div className={TASK_DETAIL_GRID}>
          <div className="flex min-w-0 flex-col gap-3">
            <TaskSurface
              taskId={task.id}
              status={task.status}
              category={category}
              resolution={task.resolution ?? ""}
              startDate={task.start_date}
              dueDate={task.due_date}
              estimateMinutes={task.estimate_minutes}
              trackedMinutes={trackedMinutes}
              priority={task.priority}
              listId={task.list_id}
              lists={lists}
              // A failed lists read must not render as "this task is in no
              // list". See the prop's note on `TaskSurface`.
              listsUnavailable={listsQuery.isError}
              assigneeId={task.assignee_id}
              qaAssigneeId={task.qa_assignee_id}
              picName={task.assignee_id ? (nameOf.get(task.assignee_id) ?? null) : null}
              qaName={task.qa_assignee_id ? (nameOf.get(task.qa_assignee_id) ?? null) : null}
              candidates={departmentPeople}
              /* P11-06 — was `viewer.leadsDepartment`, with the note
                 "reassignment is a lead decision, not self-service".
                 P11-03 had already contradicted that in the database: its
                 WITH CHECK admits any active member of the task's department
                 as the RESULT, and its USING now admits them as the ACTOR. So
                 the screen was hiding a control the server would have
                 accepted, which is the worst of both — no protection, and a
                 colleague who cannot hand work over without asking a lead.

                 The person it can be handed TO is still checked server-side:
                 `candidates` is this task's department, and `reassignTask`
                 refuses anybody outside it. */
              canReassign={canWork}
              // P7-60. Whether the empty resolution is currently BLOCKING
              // anything, so the field can say so itself. Derived here because
              // this is the one place that already holds every argument
              // `availableTransitions` takes.
              resolutionGates={availableTransitions(task.status, viewer, {
                request_id: task.request_id,
                is_personal: task.is_personal,
              }).some((transition) => transition.requires === "resolution")}
              late={late}
              /*
                P7-59 — TWO SOURCES, ONE PROP, AND THE SEAM IS THE IDENTITY.

                `brief` reaches everyone on the task and carries the reference
                and the client's date. `request` reaches department LEADS only
                and is the sole source of the name, the org and the link to the
                request page — which is why those three are nullable in the
                prop's type and the surface renders a sentence rather than a
                dash when they are absent.
              */
              request={
                brief || request
                  ? {
                      id: request?.id ?? null,
                      // `request` as the fallback so a lead's Details card still
                      // fills in if the RPC is missing — the code and the
                      // migration deploy separately, and a blank reference on the
                      // one screen leads use most is the worst way to find out.
                      reference_no: brief?.reference_no ?? request?.reference_no ?? "",
                      requester_name: request?.requester_name ?? null,
                      requester_org: request?.requester_org ?? null,
                      target_date: brief?.target_date ?? request?.target_date ?? null,
                    }
                  : null
              }
              viewer={viewer}
              brief={
                task.description ? (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground">Brief</h3>
                    {/* ⚠️ `RichTextClient`, NOT `RichText`. That component
                        sanitises as it renders and is a SERVER component for
                        that reason — it cannot be used from here. The pass
                        moved with the read; see `lib/rich-text-dom.ts`. */}
                    <RichTextClient html={task.description} />
                  </section>
                ) : null
              }
              requestPanel={
                /*
                WHAT THE CLIENT ACTUALLY SENT.

                ⚠️ DRIVEN BY `brief`, NOT BY `request`. That is the P7-59 fix and
                it is the whole reason this panel exists for most people now. It
                was gated on the request ROW, which RLS returns only to a
                department lead — so the panel vanished for the person actually
                doing the work, taking the client's own wording, their answers
                and the reference images they attached with it. The submission
                was not neglected by the approval; it was collected, stored
                correctly, and shown to nobody who needed it.

                ⚠️ AND THE CONDITION IS "did this come from a request", NOT
                `fields.length > 0`. A form built with no custom fields — which is
                every form until somebody adds one — used to make this vanish too.

                THE EMAIL IS THE ONE ROW STILL GATED ON `request`, because it is
                IDENTITY. The client is never told who at VizServe holds their
                task, and the anonymity is meant to run both ways: a lead who may
                need to contact them reads the row and sees it, and nobody else
                does.

                COLLAPSED BY DEFAULT, because once work has started it is
                reference material and the brief above is what people read —
                EXCEPT where the TL rewrote the brief. QA checks the delivered
                work against the client's ORIGINAL words, so on exactly the tasks
                where that matters it opens. It hides scroll, not fetching: the
                panel keeps its children in the DOM and every value here came from
                a query that already ran.
              */
                brief ? (
                  <Collapsible defaultOpen={Boolean(briefDiffers)} className="rounded-md border">
                    <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-foreground">From the request</p>
                        {/* The facts that decide whether opening it is worth it:
                          when they asked, and whether anything is attached. */}
                        <p className="mt-0.5 text-2xs text-muted-foreground">
                          {[
                            brief.submitted_at ? `submitted ${formatDate(brief.submitted_at)}` : null,
                            brief.attachments.length > 0
                              ? `${brief.attachments.length} ${brief.attachments.length === 1 ? "file" : "files"}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "The answers on the form"}
                        </p>
                      </div>
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
                      />
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <dl className="border-t px-3 py-1 text-sm">
                        {/*
                          ⚠️ THE REQUEST ROW FAILING IS NOT "YOU ARE NOT A LEAD",
                          and those two look identical from here. A null row is
                          the ordinary state for most of the team; an errored
                          query is a fault, and a lead who quietly stops seeing
                          the client's email would have no way to tell which had
                          happened.
                        */}
                        {requestQuery.isError ? (
                          <p role="alert" className="py-1.5 text-2xs text-destructive">
                            The client&apos;s details could not be loaded. {requestQuery.error.message}
                          </p>
                        ) : null}

                        {/* IDENTITY, so `request` and never `brief`. */}
                        {request?.requester_email ? (
                          <div className="grid gap-0.5 border-b py-1.5 last:border-0 sm:grid-cols-[10rem_1fr] sm:gap-3">
                            <dt className="text-xs text-muted-foreground">Email</dt>
                            <dd className="min-w-0 wrap-break-word">
                              {/* A link, because the reason to show an address is
                                to use it. */}
                              <a
                                href={`mailto:${request.requester_email}`}
                                className="underline-offset-2 hover:underline">
                                {request.requester_email}
                              </a>
                            </dd>
                          </div>
                        ) : null}

                        {/* The client's own words, where the task's brief has been
                          edited away from them at Gate 1. */}
                        {briefDiffers ? (
                          <div className="grid gap-0.5 border-b py-1.5 last:border-0 sm:grid-cols-[10rem_1fr] sm:gap-3">
                            <dt className="text-xs text-muted-foreground">As they wrote it</dt>
                            <dd className="min-w-0 wrap-break-word">
                              <RichTextClient html={brief.description} />
                            </dd>
                          </div>
                        ) : null}

                        {brief.fields.map((field) => {
                          /* ⚠️ THE REQUEST'S ANSWERS, NOT THE TASK'S COPY.
                             `tasks.field_values` is a snapshot taken at approval,
                             and this panel is titled "From the request" — where
                             the two ever differ, the request is what the client
                             actually said, which is what QA and Gate 3 judge the
                             work against. */
                          const raw = brief.field_values[field.field_key];
                          const rendered =
                            raw === null || raw === undefined || raw === ""
                              ? "—"
                              : Array.isArray(raw)
                                ? raw.join(", ")
                                : String(raw);

                          return (
                            <div
                              key={field.field_key}
                              className="grid gap-0.5 border-b py-1.5 last:border-0 sm:grid-cols-[10rem_1fr] sm:gap-3">
                              <dt className="text-xs text-muted-foreground">
                                {field.label}
                                {/* A historical answer must keep rendering with
                                  its label after the field is retired (D20/R5). */}
                                {!field.is_active ? <span className="ml-1 text-2xs">(archived)</span> : null}
                              </dt>
                              <dd className="min-w-0 wrap-break-word">{rendered}</dd>
                            </div>
                          );
                        })}

                        {/* THE FILES THE CLIENT SENT — `request_attachments`, not
                          the team's outputs. A brief with three reference images
                          attached used to reach the person doing the work as a
                          title and a sentence.

                          `taskId` is what lets a member open them: that table is
                          lead-scoped as well, so the download falls back to a
                          seat test on this task (P7-59). Without it the list
                          would name files it then refuses on click. */}
                        {brief.attachments.length > 0 ? (
                          <div className="grid gap-0.5 py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
                            <dt className="text-xs text-muted-foreground">
                              {brief.attachments.length === 1 ? "Attached file" : "Attached files"}
                            </dt>
                            <dd className="min-w-0">
                              <RequestAttachmentList taskId={task.id} attachments={brief.attachments} />
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </CollapsibleContent>
                  </Collapsible>
                ) : null
              }
              outputs={
                attachmentsQuery.isError ? (
                  <QueryError what="the output files" message={attachmentsQuery.error.message} />
                ) : (
                  <TaskOutputs
                    variant="field"
                    taskId={task.id}
                    attachments={outputs}
                    // ONE COLUMN, so one link — "Paste a link" in the menu
                    // replaces it rather than appending, and the dialog says so.
                    outputLink={task.output_link ?? ""}
                    // Uploading is doing the work. A department lead can too — they
                    // are frequently the QA and sometimes the person picking up the
                    // pieces. A finished task takes no new files.
                    canUpload={canWork && !isTerminal(task.status)}
                    uploaderNames={nameOf}
                  />
                )
              }
              subtasks={
                subtasksQuery.isError ? (
                  <QueryError what="the subtasks" message={subtasksQuery.error.message} />
                ) : subtasksQuery.isPending ? (
                  /* ⚠️ NOT `SubtaskList` WITH AN EMPTY ARRAY. Its empty state
                     reads "Nothing broken out yet", which is a claim about the
                     task and not a gap on the screen. */
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground">Subtasks</h3>
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  </section>
                ) : (
                  <SubtaskList subtasks={children} nameOf={nameOf} canAdd={canWork && !isTerminal(task.status)} />
                )
              }
              actions={
                canWork && !isTerminal(task.status) ? (
                  <AddSubtask
                    parentId={task.id}
                    assignable={departmentPeople}
                    label="Add a subtask"
                    className={ACTION_LINK}
                  />
                ) : null
              }
            />
          </div>

          {/*
          HISTORY STAYS UNCLAMPED — no sticky, no max-height. The point of a
          column of its own is that a long trail can just run, and a scrollbar
          inside a card sitting in a page that also scrolls is the arrangement
          people lose their place in.

          ⚠️ COMMENTS IS THE DELIBERATE EXCEPTION, because it has a COMPOSER.
          Its log is capped and scrolls (`scrollList`) so the box you type into
          stays reachable without scrolling past the whole thread first.
        */}
          <div className="flex min-w-0 flex-col gap-3">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Activity</CardTitle>
                <CardDescription className="text-xs">Comments, QA and client replies</CardDescription>
                {/* The count in the header, so the rail is scannable without
                  reading the thread — and so an empty one says so before you
                  look for a composer.

                  ⚠️ NO COUNT WHILE EITHER HALF IS MISSING. "Nothing yet" over a
                  failed read is the exact lie this phase exists to stop, and
                  the two halves arrive from two different keys. */}
                <CardAction>
                  <span className="text-2xs text-muted-foreground">
                    {commentsQuery.isError || historyQuery.isError || commentsQuery.isPending || historyQuery.isPending
                      ? null
                      : commentRows.length + activity.length === 0
                        ? "Nothing yet"
                        : `${commentRows.length + activity.length} entries`}
                  </span>
                </CardAction>
              </CardHeader>
              <CardContent>
                {/*
                THE COMPOSER AT THE TOP AND THE FEED NEWEST-FIRST, which is the
                one place this page reads differently from the popover on the
                list. Here it is a feed you scan for what just happened; there it
                is a short conversation you read in order.

                ⚠️ NO BANNER ABOVE IT. An earlier cut of this repeated the latest
                QA return in a strip above the card, and the top row of the feed
                held the same words two inches below. One fact drawn twice is not
                emphasis; it is noise that makes the reader check whether they are
                two different things. The emphasis lives INSIDE the feed instead —
                the newest return is tinted, bordered and named, and drops back to
                an ordinary row once the task moves on.

                ⚠️ THE THREAD AND THE FEED ARE TWO KEYS NOW, so either can fail
                on its own. Both are reported, and the composer is NOT drawn over
                a failed comments read: a box that posts into a thread nobody can
                see is worse than no box.
              */}
                {commentsQuery.isError ? (
                  <QueryError what="the comments" message={commentsQuery.error.message} />
                ) : commentsQuery.isPending ? (
                  /* ⚠️ NOT `CommentThread` WITH AN EMPTY ARRAY. It would draw a
                     composer over a thread it has not read yet, and the feed
                     would say there is nothing on a task that may well have
                     forty comments. A composer that posts into a thread nobody
                     can see is the same objection as the error branch above. */
                  <p className="text-xs text-muted-foreground">Loading the thread…</p>
                ) : (
                  <>
                    {historyQuery.isError ? (
                      <p role="alert" className="mb-2 text-2xs text-destructive">
                        QA and client replies could not be loaded, so this feed is comments only.{" "}
                        {historyQuery.error.message}
                      </p>
                    ) : null}

                    <CommentThread
                      scrollList
                      composerFirst
                      newestFirst
                      taskId={task.id}
                      viewerId={seat.userId}
                      events={activity}
                      comments={commentRows.map((row) => ({
                        id: row.id,
                        /* ⚠️ SANITISED WHERE THE ROW IS READ — the same seam
                           `page.tsx` held before this phase, moved into the
                           browser with the read. `comment-thread.tsx` paints
                           this with `dangerouslySetInnerHTML` and says in its
                           own note that the markup is trusted because of where
                           it came from. This is where it came from. */
                        body: sanitizeRichTextInBrowser(row.body),
                        authorId: row.author_id,
                        authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
                        createdAt: row.created_at,
                        updatedAt: row.updated_at,
                      }))}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>History</CardTitle>
                {/* THE AUDIT LOG, AND NOTHING ELSE. The lifecycle summary that used
                  to sit on top of this trail is the track across the top of the
                  page now — see the note there for why the two cannot share a
                  panel. */}
                <CardDescription className="text-xs">Every move, newest first</CardDescription>
              </CardHeader>
              <CardContent>
                {historyQuery.isError ? (
                  /* ⚠️ "Nothing recorded yet" WOULD BE A LIE ABOUT AN AUDIT LOG.
                     Every task has at least the row that created it, so an empty
                     trail is already suspicious — and this is the panel a dispute
                     turns on. It says it is broken instead. */
                  <QueryError what="this task's history" message={historyQuery.error.message} />
                ) : historyQuery.isPending ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  /* The longest thing on the page — a task round QA twice already
                   runs a dozen entries, each a single line unless it carries a
                   comment, so `space-y-3` spent more height on gaps than trail. */
                  /* `max-h-96` collapsed, and it SCROLLS rather than clipping —
                     an audit trail that silently ends mid-row would be worse
                     than a long one. Expanded it takes whatever height it
                     needs, because the point of expanding is to read it. */
                  <ol
                    className={cn(
                      "space-y-1.5",
                      !historyExpanded && history.length > HISTORY_COLLAPSED && "max-h-96 overflow-y-auto pr-1",
                    )}
                  >
                    {(historyExpanded ? history : history.slice(0, HISTORY_COLLAPSED)).map((entry) => (
                      <li key={entry.id} className="border-l-2 pl-2.5 text-sm">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          {/* An icon, never a typed arrow. A glyph in a text run
                            inherits the font's metrics and sits off the
                            baseline; `ArrowRight` is sized and aligned with the
                            words either side, and `aria-hidden` because
                            "Ongoing For QA" already reads as a move to anyone
                            listening rather than looking. */}
                          <span className="flex flex-wrap items-center gap-1.5 font-medium">
                            {entry.from_status ? (
                              <>
                                {TASK_STATUS_LABELS[entry.from_status]}
                                <ArrowRight className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />
                                {TASK_STATUS_LABELS[entry.to_status]}
                              </>
                            ) : (
                              `Created as ${TASK_STATUS_LABELS[entry.to_status]}`
                            )}
                          </span>
                          {/* An override that reads like an ordinary step is an
                            override that destroys the trail it appears in. */}
                          {entry.is_override ? <Chip tone="warning" label="Forced" /> : null}
                          <span className="text-xs text-muted-foreground">
                            {entry.actor_id ? (nameOf.get(entry.actor_id) ?? "Someone") : "System"}
                            {" · "}
                            {formatDateTime(entry.created_at)}
                          </span>
                        </div>
                        {/* ⚠️ ONLY THE OVERRIDE'S REASON. Every other note on a
                          move — a QA return, a client reply, a parked task — is
                          rendered in Activity above, and printing it here as well
                          would put the same words on screen twice in one column.
                          A forced move's reason has nowhere else to be, and it is
                          the half of the record an audit turns on. */}
                        {entry.is_override && entry.comment ? (
                          <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{entry.comment}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}

                {/* ⚠️ IT SAYS HOW MANY, because "Show more" alone does not tell
                    somebody whether the answer they are looking for is two rows
                    down or forty. Rendered only when there is more — a button
                    that reveals nothing is a button that teaches people to stop
                    pressing it. */}
                {!historyQuery.isPending && !historyQuery.isError && history.length > HISTORY_COLLAPSED ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 w-full text-xs"
                    onClick={() => setHistoryExpanded((shown) => !shown)}
                  >
                    {historyExpanded
                      ? "Show fewer"
                      : `Show all ${history.length} moves`}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      </TaskGateProvider>
    </PageShell>
  );
}

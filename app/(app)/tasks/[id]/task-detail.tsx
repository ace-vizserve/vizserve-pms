"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ChevronRight, MessagesSquare } from "lucide-react";
import Link from "next/link";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { Chip } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RichTextClient } from "@/components/ui/rich-text-client";
import type { Json } from "@/lib/database.types";
import { formatDate, formatDateTime } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchCollaborators,
  fetchDirectory,
  fetchListFields,
  fetchSubtasks,
  fetchTaskAttachments,
  fetchTaskChecklist,
  fetchTaskComments,
  fetchTaskDetail,
  fetchTaskHistory,
  fetchTaskRequest,
  fetchTaskTimeTracked,
  fetchVisibleLists,
} from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";
import { useRefetchOnServerRender } from "@/lib/query/use-refetch-on-server-render";
import { richTextToPlainText } from "@/lib/rich-text";
import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";
import {
  TASK_STATUS_LABELS,
  availableTransitions,
  isTaskOverdue,
  isTerminal,
  taskCategory,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { CommentSheet } from "../comment-sheet";
import { CommentThread, type TaskActivityEvent } from "../comment-thread";
import { AddSubtask } from "../inline";

import { Checklist } from "./checklist";
import { RequestAttachmentList } from "./client-files";
import { TaskDetailSkeleton } from "./detail-skeleton";
import { TASK_DETAIL_GRID } from "./grid";
import { GateTrack } from "./lifecycle-rail";
import { SubtaskList } from "./subtask-list";
import { TaskGateProvider } from "./task-gate";
import { TaskHeader } from "./task-header";
import { TaskOutputs } from "./task-outputs";
import { TaskSection } from "./task-section";
import { TaskSurface } from "./task-surface";

/**
 * P12-06 — `/tasks/[id]`, read from the query cache.
 *
 * ⚠️ THE LAYOUT BELOW IS MAIN'S, MOVED, NOT REDESIGNED. Everything this page
 * drew as a server component it draws here from the same data — custom fields,
 * the checklist, sections that fold, the comment sheet, the request panel — and
 * the long notes on each block travelled with it. What changed is only where
 * the rows come from: cache entries instead of one server batch, so a task you
 * have opened before paints at once and a colleague's edit arrives through
 * realtime invalidation rather than a route render.
 *
 * ⚠️ AUTHORIZATION STAYS ON THE SERVER. `seat` is computed in `page.tsx` from
 * `AuthContext`, which never reaches the browser; this file only combines it
 * with the task row the way the RSC did. RLS still scopes every read.
 *
 * ⚠️ ALL-OR-NOTHING, LIKE THE PAGE IT REPLACES. The panels wait for their reads
 * rather than rendering "Nothing yet" over a read still in flight — an empty
 * checklist or thread that is really a pending one is a false claim about the
 * task. Two reads degrade instead of blocking: time tracked (reads as 0, as the
 * RSC's `?? 0` did) and the request row (lead-only, so null is the ordinary
 * answer).
 */

/** How many Activity entries the card shows before handing over to the sheet. */
const ACTIVITY_PREVIEW = 2;

export type TaskSeat = {
  userId: string;
  /** Holds a row in `vizserve_pms_task_assignees` for this task. */
  joined: boolean;
  leadsDepartment: boolean;
  isAdmin: boolean;
  /** P11-05 / P13-01 — a member of this task's department, or its collaboration space. */
  inDepartment: boolean;
  /** P8-01c — holds the Admin tick on THIS task's department. */
  administersDepartment: boolean;
  /** P13-01 — the task lives in the space every department shares. */
  collaboration: boolean;
};

export function TaskDetail({
  taskId,
  seat,
  realtimeFilter,
  today,
  serverRenderedAt,
  initialListId,
  initialRequestId,
}: {
  taskId: string;
  seat: TaskSeat;
  /** `realtimeDepartmentFilter(context)`, computed on the server. */
  realtimeFilter: string | null;
  /** The request's date in the app zone, from the server — so overdue agrees with it. */
  today: string;
  /** When the server last rendered the page. See `useRefetchOnServerRender`. */
  serverRenderedAt: number;
  /** The task's list and request, from the row `page.tsx` read. See `listId` below. */
  initialListId: string | null;
  initialRequestId: string | null;
}) {
  // Any write that only revalidates the path still reaches the cached task.
  useRefetchOnServerRender(serverRenderedAt, [qk.task(taskId)]);

  const taskQuery = useQuery({
    queryKey: qk.task(taskId),
    queryFn: () => fetchTaskDetail(browserClient(), taskId),
  });

  const task = taskQuery.data?.task;

  /*
   * ⚠️ THE LIST AND REQUEST IDS COME FROM THE SERVER'S ROW UNTIL THE CACHED ONE
   * LANDS. History, custom fields and the request row each need one of them;
   * waiting for `taskQuery` to supply it put two more browser → database round
   * trips IN SERIES behind it, and the page shows nothing until the last read
   * is in. `page.tsx` has already read the row to decide the seat, so these
   * reads now start in the same wave as the rest. Once the cached row arrives it
   * wins, so a task moved to another list re-keys and refetches.
   */
  const listId = task ? task.list_id : initialListId;
  const requestId = task ? task.request_id : initialRequestId;
  const hasRequest = Boolean(requestId);

  const historyQuery = useQuery({
    queryKey: qk.taskPart(taskId, "history"),
    queryFn: () => fetchTaskHistory(browserClient(), taskId, { hasRequest }),
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
  const checklistQuery = useQuery({
    queryKey: qk.taskPart(taskId, "checklist"),
    queryFn: () => fetchTaskChecklist(browserClient(), taskId),
  });
  const timeQuery = useQuery({
    queryKey: qk.taskPart(taskId, "time"),
    queryFn: () => fetchTaskTimeTracked(browserClient(), taskId),
  });
  const peopleQuery = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
  });
  const listsQuery = useQuery({
    queryKey: qk.listsVisible(),
    queryFn: () => fetchVisibleLists(browserClient()),
  });
  const fieldsQuery = useQuery({
    queryKey: qk.listFields(listId ?? ""),
    queryFn: () => fetchListFields(browserClient(), listId!),
    enabled: Boolean(listId),
  });
  const collaboratorsQuery = useQuery({
    queryKey: qk.ref("collaborators"),
    queryFn: () => fetchCollaborators(browserClient()),
    enabled: seat.collaboration,
  });
  const requestQuery = useQuery({
    queryKey: qk.request(requestId ?? ""),
    queryFn: () => fetchTaskRequest(browserClient(), requestId!),
    enabled: hasRequest,
  });

  // Required reads: the page is not drawn until every one of them is in.
  const required = [
    taskQuery,
    historyQuery,
    commentsQuery,
    subtasksQuery,
    attachmentsQuery,
    checklistQuery,
    peopleQuery,
    listsQuery,
    ...(listId ? [fieldsQuery] : []),
    ...(seat.collaboration ? [collaboratorsQuery] : []),
  ];

  const failed = required.find((query) => query.isError);
  if (failed?.error) {
    return (
      <PageShell className="gap-3">
        <QueryError what="this task" message={failed.error.message} />
      </PageShell>
    );
  }

  if (!task || required.some((query) => query.isPending)) {
    return (
      <PageShell className="gap-3">
        <div role="status" aria-label="Loading this task" className="contents">
          <TaskDetailSkeleton />
        </div>
      </PageShell>
    );
  }

  const brief = taskQuery.data?.brief ?? null;
  const coverage = taskQuery.data?.coverage ?? [];
  // Lead-only: `null` is the ordinary answer for everybody else, and a failed
  // read degrades to the same, exactly as the RSC's `{ data }` did.
  const request = requestQuery.data ?? null;
  const history = historyQuery.data?.history ?? [];
  const decisions = historyQuery.data?.decisions ?? [];
  const commentRows = commentsQuery.data ?? [];
  const children = subtasksQuery.data ?? [];
  const outputs = attachmentsQuery.data ?? [];
  const checklistItems = checklistQuery.data ?? [];
  const customFields = fieldsQuery.data ?? [];
  const people = peopleQuery.data ?? [];
  // The department's active lists, as the RSC read them.
  const lists = (listsQuery.data ?? [])
    .filter((list) => list.department_id === task.department_id)
    .map((list) => ({ id: list.id, name: list.name }));

  const briefDiffers = Boolean(
    brief?.description && richTextToPlainText(brief.description) !== richTextToPlainText(task.description ?? ""),
  );

  // Every name on the page, the departed included — their old comments and
  // history rows still need one. Seats filter `is_active` themselves, below.
  const nameOf = new Map(people.map((person) => [person.id, person.full_name]));

  const trackedMinutes = timeQuery.data ?? 0;

  const latestDecision = decisions[0] ?? null;

  const category = taskCategory({
    request_id: task.request_id,
    is_personal: task.is_personal,
  });

  const clientNameAt = new Map(decisions.map((decision) => [decision.created_at, decision.approver_name]));

  const activity: TaskActivityEvent[] = history
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
        said: entry.comment ? sanitizeRichTextInBrowser(entry.comment) : null,
      } satisfies TaskActivityEvent;
    });

  // The newest QA or client return is "live" while the task is back in work.
  const live =
    task.status === "ONGOING"
      ? (activity.find((entry) => entry.kind === "qa" || entry.kind === "client")?.id ?? null)
      : null;

  for (const entry of activity) entry.live = entry.id === live;

  const viewer = {
    isAssignee: task.assignee_id === seat.userId || seat.joined,
    isQa: task.qa_assignee_id === seat.userId,
    leadsDepartment: seat.leadsDepartment,
    isAdmin: seat.isAdmin,
    inDepartment: seat.inDepartment,
    administersDepartment: seat.administersDepartment,
  };

  const listName = lists.find((list) => list.id === task.list_id)?.name ?? null;

  const late = isTaskOverdue(task, today);

  const canWork = viewer.isAssignee || viewer.isQa || viewer.leadsDepartment || viewer.inDepartment;

  // Who the task can be handed to. The collaboration space draws from everybody
  // who may collaborate; any other department from its own ACTIVE members.
  const departmentPeople = seat.collaboration
    ? (collaboratorsQuery.data ?? [])
    : people
        .filter((person) => person.is_active && person.primary_department_id === task.department_id)
        .map((person) => ({ id: person.id, full_name: person.full_name }));

  const customValues = (task.custom_fields ?? {}) as Json;

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

        The cost is refreshes this page did not need: a card moving on a
        colleague's board re-runs this render. It is a cheap RSC re-fetch,
        debounced, and the alternative was a second channel shape whose
        coverage gaps would have to be worked out per component.

        ⚠️ AND NOT IN THE DIALOG (P12-18). The channel topic is
        `p8-03:tasks:${filter}` and `use-realtime-refresh` requires it to be
        unique per (table, filter) — the list or the board UNDERNEATH the dialog
        has already subscribed to exactly this one, so mounting it again would
        be two subscriptions on one topic. It costs nothing: the dialog renders
        inside that page's tree, so the refresh the page performs re-runs this
        component with it.
      */}
      <RealtimeTasks filter={realtimeFilter} />
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={task.title} />
      {/*
          BACK TO THE LIST THIS TASK IS IN, not to `/tasks`.

          ⚠️ `/tasks` ON ITS OWN IS NOT A PAGE. With no `?list=` and no
          `?view=mine|qa` it redirects to `/tasks/lists` (see the guard at the
          top of `../page.tsx`), so a bare "All tasks" link always landed
          somewhere other than where the reader came from — and a link whose
          destination redirects reads as a bug even when the redirect is
          deliberate.

          ⚠️ AND THE PARAMETER IS `?list=<id>`, WHICH IS EASY TO MISTYPE INTO
          SOMETHING THAT STILL LOOKS RIGHT. `?=list<id>` parses cleanly, carries
          no `list` at all, and lands in that same redirect.

          A task with no list falls back to the index, which is the honest
          destination when there is no list to go back to.
      */}
      <Link
        href={task.list_id ? `/tasks?list=${task.list_id}` : "/tasks/lists"}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        {listName ?? "All lists"}
      </Link>
      {/*
        P7-57 — THE GATE STATE IS SHARED, and this is the reason for the wrapper.

        "Send for QA" is refused by the database while the resolution is empty.
        The button is in the header now and the field is in the surface below, so
        the two are separate trees under a server component and neither can hold
        the other's state. `TaskGateProvider` holds it: the surface pushes the
        saved value and its autosave flush, the header reads them. See
        `task-gate.tsx` — the alternative was making this whole page a client
        component that takes six slots.
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
          listName={listName}
          dueDate={task.due_date}
          late={late}
        />

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
              lists={lists ?? []}
              customFields={customFields}
              customValues={customValues}
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
                  <TaskSection id="brief" title="Brief">
                    <RichTextClient html={task.description} />
                  </TaskSection>
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
                <TaskOutputs
                  variant="field"
                  taskId={task.id}
                  attachments={outputs ?? []}
                  // ONE COLUMN, so one link — "Paste a link" in the menu
                  // replaces it rather than appending, and the dialog says so.
                  outputLink={task.output_link ?? ""}
                  // Uploading is doing the work. A department lead can too — they
                  // are frequently the QA and sometimes the person picking up the
                  // pieces. A finished task takes no new files.
                  canUpload={canWork && !isTerminal(task.status)}
                  uploaderNames={nameOf}
                />
              }
              checklist={<Checklist taskId={task.id} items={checklistItems} />}
              subtasks={
                <SubtaskList
                  today={today}
                  subtasks={children}
                  nameOf={nameOf}
                  /* ⚠️ NOT GATED ON `canWork` (16 Sep 2026). Anybody who can SEE
                     the task may break it into subtasks: the seat test was
                     stopping colleagues from splitting up work they were already
                     reading and about to help with, which is the opposite of
                     what a subtask is for.

                     The server still decides. `vizserve_pms_set_task_parent` and
                     the tasks policies refuse a caller outside the task's
                     department, so this offers the control and the database
                     enforces the rule — the one case where that ordering is
                     right, because the refusal is rare and the cost of hiding it
                     is a colleague who cannot help. */
                  canAdd={!isTerminal(task.status)}
                  /* In the section's own header now, beside its progress bar,
                     the way "Add output" has always been. See `SubtaskList`. */
                  action={
                    !isTerminal(task.status) ? (
                      <AddSubtask
                        parentId={task.id}
                        assignable={departmentPeople}
                        label="Add a subtask"
                        className={buttonVariants({ variant: "outline", size: "xs" })}
                      />
                    ) : null
                  }
                />
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
                  look for a composer. */}
                <CardAction>
                  <span className="text-2xs text-muted-foreground">
                    {(commentRows?.length ?? 0) + activity.length === 0
                      ? "Nothing yet"
                      : `${(commentRows?.length ?? 0) + activity.length} entries`}
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
              */}
                <CommentThread
                  /*
                   * ⚠️ `limit`, NOT `scrollList`, AND THAT IS THE FIX FOR THE
                   * PHANTOM SCROLL. This card used to draw the whole thread into
                   * a 24rem scroll box: the reader saw 384px, the layout
                   * accounted for two thousand, and the difference came out as a
                   * page that scrolled into empty space — nothing to inspect,
                   * because a box's surplus content is not an element.
                   *
                   * Three entries are three entries. The card is as tall as what
                   * is in it, and the rest of the conversation is a click away in
                   * a panel built to scroll — see `CommentSheet`.
                   */
                  limit={ACTIVITY_PREVIEW}
                  composerFirst
                  newestFirst
                  taskId={task.id}
                  viewerId={seat.userId}
                  events={activity}
                  comments={(commentRows ?? []).map((row) => ({
                    id: row.id,
                    body: sanitizeRichTextInBrowser(row.body),
                    authorId: row.author_id,
                    authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                  }))}
                />

                {/*
                  THE WAY TO THE REST OF THE CONVERSATION, AND IT IS A BUTTON.

                  It was an `ACTION_LINK` — muted, small, indistinguishable from
                  the "Add a subtask" text links on the other card. But those are
                  optional extras beside content you can already see, and this is
                  the opposite: three entries out of twenty-four, with the other
                  twenty-one reachable ONLY here. A control that is the sole route
                  to most of the content on a card cannot be the quietest thing on
                  it.

                  Full width under the thread, so it reads as the end of the list
                  rather than as a footnote beside it — and `buttonVariants`
                  rather than a hand-rolled copy of them, so it stays in step with
                  every other outline button in the app (this module has no
                  "use client", so a server component may call it).

                  ⚠️ ONLY WHEN THERE IS A REST. A button that opens the same three
                  entries in a panel is a control that does nothing.
                */}
                {(commentRows?.length ?? 0) + activity.length > ACTIVITY_PREVIEW ? (
                  <CommentSheet
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3 w-full")}
                    taskId={task.id}
                    taskTitle={task.title}
                    viewerId={seat.userId}
                    events={activity}
                    comments={(commentRows ?? []).map((row) => ({
                      id: row.id,
                      body: sanitizeRichTextInBrowser(row.body),
                      authorId: row.author_id,
                      authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
                      createdAt: row.created_at,
                      updatedAt: row.updated_at,
                    }))}>
                    <MessagesSquare className="size-3.5" aria-hidden />
                    Show all {(commentRows?.length ?? 0) + activity.length} entries
                  </CommentSheet>
                ) : null}
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
                {!history || history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  /* The longest thing on the page — a task round QA twice already
                   runs a dozen entries, each a single line unless it carries a
                   comment, so `space-y-3` spent more height on gaps than trail. */
                  <ol className="space-y-1.5">
                    {history.map((entry) => (
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
              </CardContent>
            </Card>
          </div>
        </div>
      </TaskGateProvider>
    </PageShell>
  );
}

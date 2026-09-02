import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { Chip } from "@/components/status-badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { canAdminDepartment, requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { RichText } from "@/components/ui/rich-text";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { richTextToPlainText } from "@/lib/rich-text";
import { sanitizeRichText } from "@/lib/rich-text-server";
import {
  TASK_STATUS_LABELS,
  availableTransitions,
  isTerminal,
  parseTaskRequestBrief,
  taskCategory,
} from "@/lib/schemas/tasks";

import { ACTION_LINK, TASK_DETAIL_GRID } from "./grid";
import { createClient } from "@/utils/supabase/server";
import { fetchJoinedTaskIdSet } from "@/lib/tasks-server";
import { CommentThread, type TaskActivityEvent } from "../comment-thread";
import { AddSubtask } from "../inline";

import { RequestAttachmentList } from "./client-files";
import { GateTrack } from "./lifecycle-rail";
import { SubtaskList } from "./subtask-list";
import { TaskGateProvider } from "./task-gate";
import { TaskHeader } from "./task-header";
import { TaskOutputs } from "./task-outputs";
import { TaskSurface } from "./task-surface";

export const metadata: Metadata = { title: "Task" };

/**
 * P3-05 — task detail.
 *
 * The QA screen (P3-08) is this page seen by the QA reviewer, not a separate
 * one. The reviewer needs exactly what the PIC had — the original request's
 * fields, the resolution, the output — and building a second screen to show the
 * same things is how the two drift until QA is reviewing against a stale copy.
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();
  const supabase = await createClient();

  // Out of scope returns no row under RLS, so this 404s rather than confirming
  // the task exists to someone who cannot see it.
  const { data: task } = await supabase
    .from("vizserve_pms_tasks")
    .select(
      "id, title, description, status, resolution, output_link, due_date, start_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, is_personal, priority, estimate_minutes, field_values, created_by, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!task) notFound();

  const [
    { data: history },
    { data: people },
    { data: lists },
    { data: request },
    { data: outputs },
    { data: commentRows },
    { data: subtasks },
    { data: trackedRows },
    { data: decisions },
  ] = await Promise.all([
    supabase
      .from("vizserve_pms_task_status_history")
      .select("id, from_status, to_status, actor_id, comment, is_override, created_at")
      .eq("task_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("vizserve_pms_users")
      .select("id, full_name, primary_department_id")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("vizserve_pms_lists")
      .select("id, name")
      .eq("department_id", task.department_id)
      .eq("is_active", true)
      .order("name"),
    task.request_id
      ? supabase
          .from("vizserve_pms_requests")
          /*
           * P7-59 — ⚠️ THIS QUERY IS THE LEAD'S VIEW, AND ONLY THE LEAD'S.
           *
           * `requests readable in department scope` returns NO ROW to a member
           * PIC, deliberately: the client is never told who at VizServe holds
           * their task, so the anonymity runs both ways. Everything the person
           * doing the work actually needs — the reference, the client's own
           * wording, the date they asked for, their answers and their files —
           * comes from `vizserve_pms_task_request_brief` below, which returns
           * the brief WITHOUT the identity.
           *
           * So what is left here is the identity plus Gate 1. `reviewed_by` /
           * `reviewed_at` cost no extra query — the row is already being read —
           * and without them the track could say the gate had been passed but
           * never who passed it, which is the half of an approval that matters
           * when somebody asks later.
           */
          .select(
            "id, reference_no, requester_name, requester_email, requester_org, description, target_date, submitted_at, reviewed_by, reviewed_at, form_id",
          )
          .eq("id", task.request_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("vizserve_pms_task_attachments")
      .select("id, filename, mime_type, size_bytes, uploaded_by")
      .eq("task_id", id)
      .order("created_at"),
    // P7-08. Oldest first, which is reading order for a conversation.
    supabase
      .from("vizserve_pms_task_comments")
      .select("id, body, author_id, created_at, updated_at")
      .eq("task_id", id)
      .order("created_at", { ascending: true }),

    /*
     * P7-28 — THE SUBTASKS, which this page has never shown.
     *
     * The list has drawn a progress bar from these since K5; the detail page
     * drew nothing, so the one screen you open to work on a task was the one
     * screen that could not tell you it had four children. P7-09 is one level
     * deep and trigger-enforced, so this is a single flat query — no recursion.
     *
     * Same order as the list's own groups: it is a queue, not a trail.
     */
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, due_date, assignee_id, priority")
      .eq("parent_task_id", id)
      .order("created_at"),

    /*
     * P7-15 — TIME TRACKED CANNOT BE A PLAIN SUM. This is the trap, and it is
     * the same one `app/(app)/tasks/page.tsx` documents at its own call.
     *
     * `vizserve_pms_timesheet_entries`' SELECT policy is owner-or-their-lead,
     * so a member summing that table for this task would see only the hours
     * THEY logged and read it as the task total. Two people on one task would
     * see two different figures on the same screen and their lead a third.
     * The rollup is SECURITY DEFINER for exactly that reason, and it returns a
     * row only for tasks the caller may already see.
     */
    supabase.rpc("vizserve_pms_task_time_tracked", { p_task_ids: [id] }),

    /*
     * GATE 3 — what the client actually said, and only where there is a client.
     *
     * Newest first: a returned task goes round again, so a task can carry a
     * REVISION_REQUESTED and then an APPROVED, and the rail reports the most
     * recent one. Scoped by the task's own policy (P4), so a task out of scope
     * has already 404'd above.
     */
    task.request_id
      ? supabase
          .from("vizserve_pms_client_decisions")
          .select("id, decision, comment, approver_name, created_at")
          .eq("task_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: null }),
  ]);

  /*
   * P7-59 — WHAT THE CLIENT ASKED FOR, WITHOUT WHO THEY ARE.
   *
   * This replaces two direct reads — `vizserve_pms_request_attachments` for the
   * files and `vizserve_pms_form_fields` for the labels — and they had to go,
   * because both were reached through `request`, and `request` is NULL for
   * everybody who is not a department lead. The result was that the person
   * doing the work opened the one screen the work happens on and found no
   * reference, no client date, none of the answers the client gave, and none of
   * the reference images they attached. The brief was collected, stored
   * correctly, and shown to nobody who needed it.
   *
   * The obvious fix — widen the requests policy — was tried and reverted
   * (P7-58): it handed over the client's NAME, ORG and EMAIL too, and the client
   * is never told who at VizServe holds their task. Anonymity that runs one way
   * only is not anonymity.
   *
   * ⚠️ SO THE SPLIT IS COLUMNS, NOT ROWS, AND RLS CANNOT DRAW IT. This is a
   * SECURITY DEFINER projection — the same pattern the public form and the Gate
   * 3 page use — that returns the BRIEF to anyone holding a seat on the task and
   * the IDENTITY to nobody. Leads still read the row above and still see it.
   */
  const { data: briefRow } = await supabase.rpc("vizserve_pms_task_request_brief", {
    p_task_id: id,
  });

  // Null for internal work, for a caller with no seat, and for a task that does
  // not exist — three reasons, one answer, because the page treats them alike.
  const brief = parseTaskRequestBrief(briefRow);

  /*
   * P7-56 — COMPARE PROSE, NOT MARKUP.
   *
   * Both columns are rich text now, and two documents saying the same sentence
   * can differ by a wrapping tag alone. Comparing the HTML would open the
   * "As they wrote it" panel on tasks whose brief nobody has touched, and the
   * panel exists precisely to say that somebody HAS.
   */
  const briefDiffers = Boolean(
    brief?.description &&
      richTextToPlainText(brief.description) !== richTextToPlainText(task.description ?? ""),
  );

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));

  /*
   * One task, so one row — but the RPC takes and returns a set, because it is
   * the same rollup the list page calls for eighty of them. Nothing logged
   * comes back as NO ROW rather than a zero, which is why the fallback is here
   * and not in the query.
   */
  const trackedMinutes =
    ((trackedRows ?? []) as { task_id: string; minutes: number }[])[0]?.minutes ?? 0;

  const children = subtasks ?? [];

  // Newest first out of the query, so the first row is the client's most recent
  // word — a task can carry a REVISION_REQUESTED and then an APPROVED.
  const latestDecision = decisions?.[0] ?? null;

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
   * `actor_id` is deliberately NULL on those rows: the client is a real actor
   * with no user row, and attributing their decision to whoever happened to be
   * signed in would be a lie in the one record a dispute turns on.
   */
  const clientNameAt = new Map(
    (decisions ?? []).map((decision) => [decision.created_at, decision.approver_name]),
  );

  const activity: TaskActivityEvent[] = (history ?? [])
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
        (entry.from_status === "FOR_QA" || entry.from_status === "QA_IN_PROGRESS") &&
        entry.to_status === "ONGOING";

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
        said: entry.comment ? sanitizeRichText(entry.comment) : null,
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
     */
    isAssignee:
      task.assignee_id === context.userId ||
      (await fetchJoinedTaskIdSet(context.userId)).has(task.id),
    isQa: task.qa_assignee_id === context.userId,
    leadsDepartment:
      roleAtLeast(context.role, "owner") ||
      context.managedDepartmentIds.includes(task.department_id),
    isAdmin: roleAtLeast(context.role, "owner"),
    /*
     * P8-01c — the Admin tick on THIS task's department, which is what
     * `vizserve_pms_force_task_status` now also accepts.
     *
     * Beside `leadsDepartment` rather than inside it: that flag is this page's
     * approval-shaped permission and gates renaming, editing, uploading and
     * reassigning. The tick confers none of those — only the force-status link.
     */
    administersDepartment: canAdminDepartment(context, task.department_id),
  };

  const late = isOverdue(task.due_date) && !isTerminal(task.status);

  /**
   * On the task, or leading it. The single test behind renaming, editing every
   * field, uploading an output and adding a subtask — it was spelled out four
   * times in the JSX and drifted once already.
   */
  const canWork = viewer.isAssignee || viewer.isQa || viewer.leadsDepartment;

  /**
   * Who this work can be given to. The department's own people, which is the
   * same set `reassignTask` and `quickAddTask` will accept — offering anybody
   * else is offering a door the server does not open.
   */
  const departmentPeople = (people ?? [])
    .filter((person) => person.primary_department_id === task.department_id)
    .map((person) => ({ id: person.id, full_name: person.full_name }));

  return (
    // Full width, like the list pages. The old `max-w-4xl` centred a column and
    // left a third of a wide screen empty on either side.
    <PageShell className="gap-3">
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={task.title} />

      <Link
        href="/tasks"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        All tasks
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
          listName={(lists ?? []).find((list) => list.id === task.list_id)?.name ?? null}
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
                    reviewedByName: request?.reviewed_by
                      ? (nameOf.get(request.reviewed_by) ?? null)
                      : null,
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
              assigneeId={task.assignee_id}
              qaAssigneeId={task.qa_assignee_id}
              picName={task.assignee_id ? (nameOf.get(task.assignee_id) ?? null) : null}
              qaName={task.qa_assignee_id ? (nameOf.get(task.qa_assignee_id) ?? null) : null}
              candidates={departmentPeople}
              // Reassignment is a lead decision, not self-service. The server
              // re-checks it regardless of what is rendered.
              canReassign={viewer.leadsDepartment}
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
                    <RichText html={task.description} />
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
                  <Collapsible
                    defaultOpen={Boolean(
                      briefDiffers,
                    )}
                    className="rounded-md border">
                    <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-foreground">From the request</p>
                        {/* The facts that decide whether opening it is worth it:
                          when they asked, and whether anything is attached. */}
                        <p className="mt-0.5 text-2xs text-muted-foreground">
                          {[
                            brief.submitted_at
                              ? `submitted ${formatDate(brief.submitted_at)}`
                              : null,
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
                              <RichText html={brief.description} />
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
                                {!field.is_active ? (
                                  <span className="ml-1 text-2xs">(archived)</span>
                                ) : null}
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
                              <RequestAttachmentList
                                taskId={task.id}
                                attachments={brief.attachments}
                              />
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
              subtasks={
                <SubtaskList
                  subtasks={children}
                  nameOf={nameOf}
                  canAdd={canWork && !isTerminal(task.status)}
                />
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
                <CardDescription className="text-xs">
                  Comments, QA and client replies
                </CardDescription>
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
                  scrollList
                  composerFirst
                  newestFirst
                  taskId={task.id}
                  viewerId={context.userId}
                  events={activity}
                  comments={(commentRows ?? []).map((row) => ({
                    id: row.id,
                    body: sanitizeRichText(row.body),
                    authorId: row.author_id,
                    authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                  }))}
                />
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
                                <ArrowRight
                                  className="size-3.5 shrink-0 text-foreground-faint"
                                  aria-hidden
                                />
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
                          <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                            {entry.comment}
                          </p>
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

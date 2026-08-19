import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { Chip, TaskPriorityBadge, TaskStatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { TASK_STATUS_LABELS, isTerminal } from "@/lib/schemas/tasks";
import { createClient } from "@/utils/supabase/server";
import { CommentThread } from "../comment-thread";

import { RequestAttachmentList } from "./client-files";
import { TaskOutputs } from "./task-outputs";
import { TaskWorkflow } from "./task-workflow";

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
      "id, title, description, status, resolution, output_link, due_date, start_date, assignee_id, qa_assignee_id, department_id, list_id, request_id, is_personal, priority, estimate_minutes, field_values, created_at",
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
          // `requester_org`, `description` and `submitted_at` added: the person
          // doing the work was being shown a name and nothing else about who
          // asked or when, and had to open the request to find out.
          .select(
            "id, reference_no, requester_name, requester_email, requester_org, description, target_date, submitted_at, form_id",
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
  ]);

  /*
   * WHAT THE CLIENT SENT WITH THE FORM.
   *
   * This page read `vizserve_pms_task_attachments` and nothing else, so the only
   * files it could ever show were the ones the team PRODUCED. The brief,
   * reference images and spec documents the client uploaded on the public form
   * live in `vizserve_pms_request_attachments`, and from the task — the screen
   * the work is actually done on — they were invisible. The PIC had to know the
   * request existed, find it, and open it.
   *
   * Same RLS as the request itself: the policy scopes these to people who can
   * see the request, so a task out of scope has already 404'd above.
   */
  const { data: clientFiles } = task.request_id
    ? await supabase
        .from("vizserve_pms_request_attachments")
        .select("id, filename, mime_type, size_bytes")
        .eq("request_id", task.request_id)
        .order("created_at")
    : { data: null };

  // The originating form's fields, including archived ones — a historical answer
  // must keep rendering with its label after the field is retired (D20/R5).
  const { data: fields } = request
    ? await supabase
        .from("vizserve_pms_form_fields")
        .select("field_key, label, is_active")
        .eq("form_id", request.form_id)
        .order("sort_order")
    : { data: null };

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));
  const values = (task.field_values ?? {}) as Record<string, unknown>;

  const viewer = {
    isPic: task.assignee_id === context.userId,
    isQa: task.qa_assignee_id === context.userId,
    leadsDepartment: context.role === "admin" || context.managedDepartmentIds.includes(task.department_id),
    isAdmin: roleAtLeast(context.role, "admin"),
  };

  const late = isOverdue(task.due_date) && !isTerminal(task.status);

  return (
    // Full width, like the list pages — the old `max-w-4xl` centred a column
    // and left a third of a wide screen empty on either side, which is what
    // made this page feel like a scroll rather than a view.
    //
    // gap-3, and every Card below is size="sm". This page stacks five sections
    // and most of a task's life is spent scrolling between the resolution, the
    // output files and the history — at the default rhythm those three sat
    // roughly a screen apart with nothing in between them.
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

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{task.title}</h1>
            <TaskStatusBadge status={task.status} />
            <TaskPriorityBadge priority={task.priority} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {request ? (
              <>
                <Link href={`/requests/${request.id}`} className="hover:underline">
                  {request.reference_no}
                </Link>
                {" · "}
                {request.requester_name}
              </>
            ) : task.is_personal ? (
              "Your own task — you can close it yourself"
            ) : (
              "Assigned to you — it goes through review"
            )}
          </p>
        </div>

        <div className="text-right text-xs">
          <div className={late ? "font-medium text-destructive" : "text-muted-foreground"}>
            Due {formatDate(task.due_date)}
            {late ? " · overdue" : null}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            PIC {task.assignee_id ? nameOf.get(task.assignee_id) : "unassigned"}
            {task.qa_assignee_id ? ` · QA ${nameOf.get(task.qa_assignee_id)}` : null}
          </div>
        </div>
      </div>

      {/*
        Two columns from `lg` up, and this is what the reclaimed width buys —
        simply letting the old single column stretch would have given a
        resolution box a metre wide and definition rows with their label and
        value at opposite ends of the screen, which is worse than the margins.

        The split follows the job: everything you READ AND EDIT to move the task
        is the left column — brief, request fields, the work, the files it
        produced. The right column is the history and nothing else.

        History gets a column to itself because it is the one section with no
        upper bound. A task that has been round QA three times carries twenty
        entries, and in the stack that meant twenty rows of trail between the
        top of the page and its own end. Beside the work it costs no page height
        at all — it simply runs down the space the left column is not using.

        `items-start` stops the short column stretching to match the tall one,
        and `minmax(0,…)` rather than a bare `fr` is what keeps a long filename
        or an unbroken URL from blowing the track out past the viewport.
      */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          {task.description ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Brief</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{task.description}</p>
              </CardContent>
            </Card>
          ) : null}

          {/* What the client actually asked for. The QA reviewer checks the
              output against this, so it sits above the resolution rather than
              behind a tab.

              ⚠️ THE CONDITION USED TO BE `fields.length > 0`, and that was the
              bug. A form built with no custom fields — which is every form until
              somebody adds one — made this whole card vanish, taking the
              client's name, their email, their organisation, the date they asked
              for and their uploaded files with it. The submission was not
              "neglected" by the approval; it was collected, stored correctly,
              and then never rendered.

              The test is now simply "did this come from a request", because if
              it did there is always something here worth showing. */}
          {request ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>From the request</CardTitle>
                <CardDescription className="text-xs">
                  {request.reference_no}
                  {request.submitted_at ? ` · submitted ${formatDate(request.submitted_at)}` : null}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="text-sm">
                  {/* WHO ASKED. Always present — these are columns on the
                      request, not answers to a form the team may not have built
                      yet — and they are what somebody needs when the brief is
                      ambiguous and the answer is one email away. */}
                  <div className="grid gap-0.5 border-b py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
                    <dt className="text-xs text-muted-foreground">Requested by</dt>
                    <dd className="min-w-0 wrap-break-word">
                      {request.requester_name}
                      {request.requester_org ? (
                        <span className="text-muted-foreground"> · {request.requester_org}</span>
                      ) : null}
                    </dd>
                  </div>

                  {request.requester_email ? (
                    <div className="grid gap-0.5 border-b py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
                      <dt className="text-xs text-muted-foreground">Email</dt>
                      <dd className="min-w-0 wrap-break-word">
                        {/* A link, because the reason to show an address is to
                            use it. */}
                        <a href={`mailto:${request.requester_email}`} className="underline-offset-2 hover:underline">
                          {request.requester_email}
                        </a>
                      </dd>
                    </div>
                  ) : null}

                  {/* The client's own words, when the task's brief has been
                      edited away from them. The TL may rewrite the description at
                      Gate 1, and the original is the thing QA checks against. */}
                  {request.description && request.description !== task.description ? (
                    <div className="grid gap-0.5 border-b py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
                      <dt className="text-xs text-muted-foreground">As they wrote it</dt>
                      <dd className="min-w-0 whitespace-pre-wrap wrap-break-word">{request.description}</dd>
                    </div>
                  ) : null}

                  {(fields ?? []).map((field) => {
                    const raw = values[field.field_key];
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
                          {!field.is_active ? <span className="ml-1 text-2xs">(archived)</span> : null}
                        </dt>
                        <dd className="min-w-0 wrap-break-word">{rendered}</dd>
                      </div>
                    );
                  })}
                  {request.target_date ? (
                    <div className="grid gap-0.5 border-b py-1.5 last:border-0 sm:grid-cols-[10rem_1fr] sm:gap-3">
                      <dt className="text-xs text-muted-foreground">Client asked for</dt>
                      <dd>{formatDate(request.target_date)}</dd>
                    </div>
                  ) : null}

                  {/* THE FILES THE CLIENT SENT. Never shown on this page before
                      — the only attachment list here read task attachments,
                      which are the team's OUTPUTS. A brief with three reference
                      images attached arrived at the person doing the work as a
                      title and a sentence. */}
                  {clientFiles && clientFiles.length > 0 ? (
                    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
                      <dt className="text-xs text-muted-foreground">
                        {clientFiles.length === 1 ? "Attached file" : "Attached files"}
                      </dt>
                      <dd className="min-w-0">
                        <RequestAttachmentList attachments={clientFiles} />
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <TaskWorkflow
            taskId={task.id}
            status={task.status}
            title={task.title}
            description={task.description}
            resolution={task.resolution ?? ""}
            outputLink={task.output_link ?? ""}
            dueDate={task.due_date ?? ""}
            startDate={task.start_date ?? ""}
            listId={task.list_id}
            priority={task.priority}
            estimateMinutes={task.estimate_minutes}
            assigneeId={task.assignee_id}
            qaAssigneeId={task.qa_assignee_id}
            lists={lists ?? []}
            candidates={(people ?? []).filter((person) => person.primary_department_id === task.department_id)}
            viewer={viewer}
            task={{ request_id: task.request_id, is_personal: task.is_personal }}
          />

          {/* The output files belong with the work, not with the trail — they
              are what the resolution refers to, and QA reads the two together. */}
          <TaskOutputs
            taskId={task.id}
            attachments={outputs ?? []}
            // Uploading is doing the work. A department lead can too, because they
            // are frequently the QA and sometimes the person picking up the pieces.
            canUpload={(viewer.isPic || viewer.isQa || viewer.leadsDepartment) && !isTerminal(task.status)}
            uploaderNames={nameOf}
          />

          {/* P7-08. Above History and below the work itself: the conversation is
              something people take part in, the trail is something they consult.
              Same component the list's popover renders, so an edited comment
              says so in both places. */}
          <Card size="sm" className="mt-4">
            <CardHeader>
              <CardTitle>Comments</CardTitle>
            </CardHeader>
            <CardContent>
              <CommentThread
                taskId={task.id}
                viewerId={context.userId}
                comments={(commentRows ?? []).map((row) => ({
                  id: row.id,
                  body: row.body,
                  authorId: row.author_id,
                  authorName: nameOf.get(row.author_id) ?? "Someone no longer active",
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                }))}
              />
            </CardContent>
          </Card>
        </div>

        {/* History alone, deliberately unclamped — no sticky, no max-height. The
            point of giving it its own column is that a long trail can just run,
            and a scrollbar inside a card sitting in a page that also scrolls is
            the arrangement people lose their place in. */}
        <div className="min-w-0">
          <Card size="sm">
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              {!history || history.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
              ) : (
                /* The longest thing on the page — a task that has been round QA
                   twice already runs a dozen entries. Each one is a single line of
                   text unless it carries a comment, so `space-y-3` was spending
                   more height on the gaps than on the trail itself. */
                <ol className="space-y-1.5">
                  {history.map((entry) => (
                    <li key={entry.id} className="border-l-2 pl-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {/* An icon, never a typed arrow. A glyph in a text run
                            inherits the font's metrics and sits off the
                            baseline; `ArrowRight` is sized and aligned with the
                            words either side of it, and it is `aria-hidden`
                            because "Ongoing For QA" already reads as a move to
                            anyone listening rather than looking. */}
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
                      {entry.comment ? (
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
    </PageShell>
  );
}

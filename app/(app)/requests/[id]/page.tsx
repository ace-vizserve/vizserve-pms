import { ArrowLeft, ChevronRight, ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RequestStatusBadge, TaskStatusBadge } from "@/components/status-badge";
import { StageTrack } from "@/components/stage-track";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RichText } from "@/components/ui/rich-text";
import { canApproveClientRequest, requireRole } from "@/lib/auth/authorization";
import { formatDate, formatDateTime, formatDuration, isOverdue } from "@/lib/dates";
import { createClient } from "@/utils/supabase/server";

import { AttachmentList } from "./attachment-list";
import { TASK_DETAIL_GRID } from "../../tasks/[id]/grid";
import { GateTrack } from "../../tasks/[id]/lifecycle-rail";
import {
  RequestActivity,
  elapsed,
  isQaReturn,
  preTaskSteps,
  type ProgressClientDecision,
  type ProgressFeedback,
  type ProgressHistoryRow,
} from "./request-progress";
import { CancelRequestButton } from "./cancel-request";
import { ClientApprovers, type ApproverStep } from "./client-approvers";
import { UrgencyControl } from "./urgency-control";
import { ReviewPanel } from "./review-panel";
import { isTerminal } from "@/lib/schemas/tasks";

export const metadata: Metadata = { title: "Request" };

/**
 * P1-14 — request detail, READ ONLY.
 *
 * Approve / return / reject arrive in Phase 2 along with the capacity panel.
 * Deliberately not stubbed here: a disabled Approve button invites someone to
 * wire it up without the atomic task-creation transaction behind it (R9).
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-2.5 last:border-0 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  // Out of scope returns no row under RLS, which surfaces as 404 rather than a
  // "forbidden" that would confirm the reference number exists.
  const { data: request } = await supabase
    .from("vizserve_pms_requests")
    .select(
      "id, reference_no, title, description, requester_name, requester_email, requester_org, target_date, approved_target_date, urgency, field_values, status, decision_reason, submitted_at, sla_started_at, form_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (!request) notFound();

  // P16-06 — steps 2+ of the Gate 3 chain. Empty for most requests.
  const { data: extraApprovers } = await supabase
    .from("vizserve_pms_request_approvers")
    .select("id, step, name, email")
    .eq("request_id", id)
    .order("step");

  // Gate 1 is offered only while there is a decision left to make. A disabled
  // Approve on an already-decided request invites someone to wire around it.
  const awaitingDecision = request.status === "PENDING_REVIEW";

  /*
   * ⚠️ ONE WAVE, AND IT WAS FIVE. The form, the field labels, the attachments
   * and — on a decided request — the linked task and the decision log were each
   * awaited on their own line down the page, every one of them waiting on the
   * one above it for nothing. All five are keyed by something already in hand:
   * `request.form_id` from the read above, or the `id` from the URL.
   *
   * ⚠️ THE TWO CONDITIONALS ARE PRESERVED EXACTLY, and must stay that way. A
   * PENDING request still reads neither the task nor the approvals — the slot
   * holds the same inert `{ data: null }` the ternary used to — so no query
   * runs here that did not run before. Only the queueing is gone.
   */
  const [{ data: form }, { data: fields }, { data: attachments }, { data: linkedTask }, decisions] =
    await Promise.all([
      supabase
        .from("vizserve_pms_forms")
        .select("id, name, sla_minutes, department_id, urgent_days, normal_days")
        .eq("id", request.form_id)
        .maybeSingle(),

      // Includes archived fields: a historical answer must keep rendering with
      // its label even after the field is retired from the live form (D20/R5).
      supabase
        .from("vizserve_pms_form_fields")
        .select("field_key, label, field_type, is_active")
        .eq("form_id", request.form_id)
        .order("sort_order"),

      supabase
        .from("vizserve_pms_request_attachments")
        .select("id, filename, mime_type, size_bytes, field_key")
        .eq("request_id", id)
        .order("created_at"),

      /*
       * P7-59 — THE TASK THIS REQUEST BECAME.
       *
       * Approving at Gate 1 creates a task and then says nothing more about it.
       * The request page carried the submission, a green "Approved" pill and a
       * two-line Decision card, and no route onward at all — so the answer to
       * "what happened to this?" was to go to /tasks and search for the title
       * by eye.
       *
       * ⚠️ ONE QUERY, AND ONLY ONCE THE DECISION IS MADE. A pending request has
       * no task by definition, and this page already refuses to pay for the
       * capacity scan on a request decided last week — the same reasoning
       * applies in reverse.
       *
       * NO DEPARTMENT FILTER. The task policy is WIDER than the request policy
       * — a lead who can open this request necessarily manages the department
       * the task was created in — so RLS returning a row IS the permission
       * check, and restating it here would imply the policy were optional.
       */
      awaitingDecision
        ? { data: null }
        : supabase
            .from("vizserve_pms_tasks")
            .select("id, title, status, assignee_id, qa_assignee_id, due_date, list_id, resolution, output_link, client_approval_step")
            .eq("request_id", id)
            .maybeSingle(),

      /* The decision log, on the same terms and for the same reason: there is
         nothing to read until there is a decision. It was the third slot of the
         ternary below and belongs up here because it is keyed by `id` alone —
         it never wanted the form, which is the only thing that batch waits on. */
      awaitingDecision
        ? { data: null }
        : supabase
            .from("vizserve_pms_approvals")
            .select("decision, reason, created_at, approver_id")
            .eq("entity_type", "request")
            .eq("entity_id", id)
            .order("created_at", { ascending: false }),
    ]);

  // Loaded only when the panel will render — the capacity query is a scan over
  // the department's open tasks and there is no reason to pay for it on a
  // request that was decided last week.
  //
  // STILL A WAVE OF ITS OWN, and it has to be: all four are keyed by the form's
  // `department_id`, which does not exist until the read above has landed.
  const [candidates, capacity, ownList] = awaitingDecision
    ? await Promise.all([
        supabase
          .from("vizserve_pms_users")
          .select("id, full_name, role")
          .eq("primary_department_id", form?.department_id ?? "")
          .eq("is_active", true)
          .order("full_name"),
        supabase.rpc("vizserve_pms_department_capacity", {
          p_department_id: form?.department_id ?? "",
          // P16-05 — no date to compare against until the urgency is chosen.
          p_target_date: null,
        }),
        // P16-02. The only list an approval can file into: the form's own.
        supabase.from("vizserve_pms_lists").select("name").eq("form_id", request.form_id).maybeSingle(),
      ])
    : [{ data: null }, { data: null }, { data: null }];

  /*
   * Names for the three people this card can mention: whoever approved it, and
   * the two the task was handed to.
   *
   * One `in` query rather than three joins — `approver_id` was already being
   * SELECTED by the decisions query above and then never rendered, which is how
   * "Approved · 2 Sep" ended up not saying by whom.
   */
  /*
   * P15-01 — EVERYTHING THAT HAPPENED TO THE WORK AFTER GATE 1. All keyed by the
   * task, all readable by the department's leads (the same scope as this page),
   * and none of it was shown before: QA's returns, the client's answer, their
   * rating, the hours behind it.
   */
  const [history, clientDecisions, feedback, hours, list] = linkedTask
    ? await Promise.all([
        supabase
          .from("vizserve_pms_task_status_history")
          .select("from_status, to_status, actor_id, comment, is_override, created_at")
          .eq("task_id", linkedTask.id)
          .order("created_at"),
        supabase
          .from("vizserve_pms_client_decisions")
          .select("decision, approver_name, comment, created_at, step")
          .eq("task_id", linkedTask.id)
          .order("created_at"),
        supabase
          .from("vizserve_pms_feedback")
          .select("rating, comment, created_at")
          .eq("task_id", linkedTask.id)
          .order("created_at"),
        supabase.from("vizserve_pms_timesheet_entries").select("minutes, user_id").eq("task_id", linkedTask.id),
        linkedTask.list_id
          ? supabase.from("vizserve_pms_lists").select("name").eq("id", linkedTask.list_id).maybeSingle()
          : { data: null },
      ])
    : [{ data: null }, { data: null }, { data: null }, { data: null }, { data: null }];

  const historyRows = (history.data ?? []) as ProgressHistoryRow[];
  const clientRows = (clientDecisions.data ?? []) as ProgressClientDecision[];
  const feedbackRows = (feedback.data ?? []) as ProgressFeedback[];
  const loggedMinutes = (hours.data ?? []).reduce((total, row) => total + row.minutes, 0);
  const loggedPeople = new Set((hours.data ?? []).map((row) => row.user_id)).size;

  const qaReturns = historyRows.filter(isQaReturn).length;
  const revisions = clientRows.filter((row) => row.decision === "REVISION_REQUESTED").length;
  const completedAt = [...historyRows]
    .reverse()
    .find((row) => row.to_status === "COMPLETED" || row.to_status === "COMPLETED_NO_RESPONSE")?.created_at;
  const turnaroundMinutes =
    completedAt && request.submitted_at
      ? Math.round((Date.parse(completedAt) - Date.parse(request.submitted_at)) / 60_000)
      : null;

  const peopleIds = [
    ...(decisions?.data ?? []).map((decision) => decision.approver_id),
    linkedTask?.assignee_id,
    linkedTask?.qa_assignee_id,
    ...historyRows.map((row) => row.actor_id),
  ].filter((value): value is string => Boolean(value));

  const { data: people } =
    peopleIds.length > 0
      ? await supabase
          .from("vizserve_pms_users")
          .select("id, full_name")
          .in("id", [...new Set(peopleIds)])
      : { data: null };

  const nameOf = new Map((people ?? []).map((person) => [person.id, person.full_name]));

  const values = (request.field_values ?? {}) as Record<string, unknown>;

  function renderValue(raw: unknown): string {
    if (raw === null || raw === undefined || raw === "") return "—";
    if (Array.isArray(raw)) return raw.length > 0 ? raw.join(", ") : "—";
    return String(raw);
  }


  const { data: department } = form?.department_id
    ? await supabase.from("vizserve_pms_departments").select("name").eq("id", form.department_id).maybeSingle()
    : { data: null };

  const gateDecision = decisions?.data?.[0] ?? null;
  // P16-05 — late against the SLA date, and only while the work is open.
  const late =
    request.status === "APPROVED" && Boolean(linkedTask) && !isTerminal(linkedTask!.status) && isOverdue(request.approved_target_date);
  const lastClientDecision = clientRows.length > 0 ? clientRows[clientRows.length - 1]! : null;

  return (
    /*
      P15-01 — THE TASK PAGE'S SHAPE. It was one narrow column of seven cards,
      with the story of the request at the bottom. Now: the header, the pipeline
      across the top (the task page's own `GateTrack` once there is a task), and
      two columns on the template the task page shares with its skeleton — the
      request on the left, its work and what happened on the right.
    */
    <PageShell className="gap-3">
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={request.reference_no} />

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          <Link href="/requests" className="inline-flex items-center gap-1.5 hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            Requests
          </Link>
          <span className="font-medium text-foreground tabular-nums">{request.reference_no}</span>
          <RequestStatusBadge status={request.status} />
          {/* "Approved" is Gate 1's answer, not where the work is. */}
          {linkedTask ? (
            <span className="inline-flex items-center gap-1.5">
              Work
              <TaskStatusBadge status={linkedTask.status} />
            </span>
          ) : null}
          {request.approved_target_date ? (
            <span className={late ? "font-medium text-destructive tabular-nums" : "tabular-nums"}>
              due {formatDate(request.approved_target_date)}
              {/* Never colour alone. */}
              {late ? " · overdue" : null}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{request.title}</h1>
          {(request.status === "PENDING_REVIEW" ||
            request.status === "RETURNED" ||
            (request.status === "APPROVED" && linkedTask && !isTerminal(linkedTask.status))) &&
          canApproveClientRequest(context, form?.department_id ?? null) ? (
            <CancelRequestButton requestId={request.id} />
          ) : null}
        </div>
      </div>

      {request.decision_reason ? (
        <div className="rounded-lg border border-info/30 bg-info-subtle p-3">
          <p className="text-xs font-medium text-info">Decision reason</p>
          {/* P7-56. `text-info` has to come through on the wrapper — `RichText`
              sets no colour of its own, so the banner's tone is inherited. */}
          <RichText html={request.decision_reason} className="mt-1 text-info" />
        </div>
      ) : null}

      <Card size="sm" className="py-0">
        {linkedTask ? (
          <GateTrack
            status={linkedTask.status}
            category="request"
            createdAt={request.submitted_at ?? ""}
            createdByName={null}
            picName={linkedTask.assignee_id ? (nameOf.get(linkedTask.assignee_id) ?? null) : null}
            qaName={linkedTask.qa_assignee_id ? (nameOf.get(linkedTask.qa_assignee_id) ?? null) : null}
            request={{
              submittedAt: request.submitted_at,
              requesterName: request.requester_name,
              reviewedAt: gateDecision?.created_at ?? null,
              reviewedByName: gateDecision?.approver_id ? (nameOf.get(gateDecision.approver_id) ?? null) : null,
            }}
            decision={
              lastClientDecision
                ? {
                    decision: lastClientDecision.decision,
                    createdAt: lastClientDecision.created_at,
                    approverName: lastClientDecision.approver_name,
                  }
                : null
            }
          />
        ) : (
          <StageTrack
            steps={preTaskSteps(
              request.status,
              request.submitted_at,
              request.requester_name,
              gateDecision
                ? {
                    at: gateDecision.created_at,
                    by: gateDecision.approver_id ? (nameOf.get(gateDecision.approver_id) ?? null) : null,
                  }
                : null,
            )}
          />
        )}
      </Card>

      <div className={TASK_DETAIL_GRID}>
        {/* ---------------------------------------------------------- LEFT */}
        <div className="flex min-w-0 flex-col gap-3">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                <Prop label="Client">{request.requester_name}</Prop>
                {/* Bound at submission and not editable by staff — it is the
                    identity used at the Phase 4 client approval gate. */}
                <Prop label="Email">
                  <a href={`mailto:${request.requester_email}`} className="truncate hover:underline">
                    {request.requester_email}
                  </a>
                </Prop>
                <Prop label="Organisation">{request.requester_org || "—"}</Prop>
                <Prop label="Submitted">{formatDateTime(request.submitted_at)}</Prop>
                <Prop label="Form">{form?.name ?? "—"}</Prop>
                <Prop label="Department">{department?.name ?? "—"}</Prop>
                {/* P16-04 — what the client would like. Never the due date. */}
                <Prop label="Ideal finish date">{request.target_date ? formatDate(request.target_date) : "—"}</Prop>
                {/* P16-05 — the SLA date, from the urgency set at Gate 1. */}
                <Prop label="Due (SLA)">
                  {request.approved_target_date ? formatDate(request.approved_target_date) : "—"}
                </Prop>
                <Prop label="Urgency">
                  {request.status === "APPROVED" &&
                  linkedTask &&
                  !isTerminal(linkedTask.status) &&
                  canApproveClientRequest(context, form?.department_id ?? null) ? (
                    <UrgencyControl
                      requestId={request.id}
                      urgency={request.urgency as "URGENT" | "NON_URGENT" | null}
                      urgentDays={form?.urgent_days ?? 3}
                      normalDays={form?.normal_days ?? 5}
                    />
                  ) : request.urgency === "URGENT" ? (
                    "Urgent"
                  ) : request.urgency === "NON_URGENT" ? (
                    "Non-urgent"
                  ) : (
                    "—"
                  )}
                </Prop>
              </dl>

              <div className="border-t pt-3">
                <p className="mb-1 text-xs text-muted-foreground">Description</p>
                <RichText html={request.description} />
              </div>
            </CardContent>
          </Card>

          {fields && fields.length > 0 ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Submitted details</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  {fields.map((field) => (
                    <Row key={field.field_key} label={field.label}>
                      {renderValue(values[field.field_key])}
                      {!field.is_active ? (
                        <span className="ml-2 text-2xs text-muted-foreground">(archived field)</span>
                      ) : null}
                    </Row>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <Card size="sm">
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Signed on click, not on render — a URL minted here would sit in
                  the page source and in the browser history whether or not
                  anyone opened the file. */}
              <AttachmentList attachments={attachments ?? []} />
            </CardContent>
          </Card>

          {/* P14-04. Gate 1 is a Team Leader of the form's department, or the Manager — not CEO, Business Manager or Admin. */}
          {awaitingDecision && canApproveClientRequest(context, form?.department_id ?? null) ? (
            <ReviewPanel
              requestId={request.id}
              requestTitle={request.title}
              requestDescription={request.description}
              targetDate={request.target_date}
              urgentDays={form?.urgent_days ?? 3}
              normalDays={form?.normal_days ?? 5}
              candidates={candidates.data ?? []}
              capacity={capacity.data ?? []}
              currentUserId={context.userId}
              currentUserName={context.fullName}
              listName={(ownList?.data as { name: string } | null)?.name ?? null}
            />
          ) : null}
        </div>

        {/* --------------------------------------------------------- RIGHT */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* P16-06 — who signs the finished work off, in order. */}
          {(extraApprovers ?? []).length > 0 ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Client approvers</CardTitle>
              </CardHeader>
              <CardContent>
                <ClientApprovers
                  requestId={request.id}
                  canEdit={canApproveClientRequest(context, form?.department_id ?? null)}
                  steps={[
                    { id: null, step: 1, name: request.requester_name, email: request.requester_email },
                    ...(extraApprovers ?? []),
                  ].map((row) => {
                    const current = linkedTask?.client_approval_step ?? 1;
                    const state: ApproverStep["state"] =
                      linkedTask?.status === "COMPLETED"
                        ? "approved"
                        : linkedTask?.status === "FOR_CLIENT_APPROVAL"
                          ? row.step < current
                            ? "approved"
                            : row.step === current
                              ? "waiting"
                              : "next"
                          : "not_sent";
                    return { ...row, state };
                  })}
                />
              </CardContent>
            </Card>
          ) : null}
          {linkedTask ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>The work</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* ONE LINK, ONE TAB STOP — it navigates, so it is a link (§2.1). */}
                <Link
                  href={`/tasks/${linkedTask.id}`}
                  className="flex items-center gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised transition-[box-shadow,border-color] hover:border-accent-border hover:shadow-raised-lg"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-accent-border bg-accent grade-chip text-accent-foreground">
                    <ClipboardCheck aria-hidden className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{linkedTask.title}</span>
                      <TaskStatusBadge status={linkedTask.status} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {nameOf.get(linkedTask.assignee_id ?? "") ?? "Unassigned"}
                      {nameOf.get(linkedTask.qa_assignee_id ?? "")
                        ? ` · QA ${nameOf.get(linkedTask.qa_assignee_id ?? "")}`
                        : null}
                    </span>
                  </span>
                  {/* Decoration only. `--foreground-faint` is 3.44:1 and may never carry a word. */}
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-foreground-faint" />
                </Link>

                <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                  <Prop label="Due">{formatDate(linkedTask.due_date)}</Prop>
                  <Prop label="List">{list.data?.name ?? "—"}</Prop>
                  <Prop label="Time logged">
                    {loggedMinutes > 0
                      ? `${formatDuration(loggedMinutes)} · ${loggedPeople} ${loggedPeople === 1 ? "person" : "people"}`
                      : "None yet"}
                  </Prop>
                  <Prop label="Turnaround">
                    {turnaroundMinutes !== null ? elapsed(turnaroundMinutes) : "Not finished"}
                  </Prop>
                  <Prop label="QA returns">
                    {qaReturns === 0 ? "None" : `${qaReturns} ${qaReturns === 1 ? "time" : "times"}`}
                  </Prop>
                  <Prop label="Revisions">
                    {revisions === 0 ? "None" : `${revisions} from the client`}
                  </Prop>
                  {feedbackRows.length > 0 ? (
                    <Prop label="Rating">{feedbackRows[feedbackRows.length - 1]!.rating} out of 5</Prop>
                  ) : null}
                  {linkedTask.output_link ? (
                    <Prop label="Output">
                      <a
                        href={linkedTask.output_link}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-primary hover:underline"
                      >
                        {linkedTask.output_link}
                      </a>
                    </Prop>
                  ) : null}
                </dl>

                {linkedTask.resolution ? (
                  <div className="border-t pt-3">
                    <p className="mb-1 text-xs text-muted-foreground">Resolution</p>
                    <RichText html={linkedTask.resolution} />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card size="sm">
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription className="text-xs">Every step, newest first</CardDescription>
            </CardHeader>
            <CardContent>
              <RequestActivity
                submittedAt={request.submitted_at}
                requesterName={request.requester_name}
                gateDecisions={decisions?.data ?? []}
                history={historyRows}
                clientDecisions={clientRows}
                feedback={feedbackRows}
                nameOf={nameOf}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}

/** One property, label beside value — the task page's `Prop`. */
function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <dt className="w-24 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">{children}</dd>
    </div>
  );
}

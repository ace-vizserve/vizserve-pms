import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RequestStatusBadge, TaskStatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RichText } from "@/components/ui/rich-text";
import { requireRole } from "@/lib/auth/authorization";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { emailJsConfig } from "@/lib/emailjs";
import { createClient } from "@/utils/supabase/server";

import { AttachmentList } from "./attachment-list";
import { ReviewPanel } from "./review-panel";

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
      "id, reference_no, title, description, requester_name, requester_email, requester_org, target_date, approved_target_date, field_values, status, decision_reason, submitted_at, sla_started_at, form_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (!request) notFound();

  const { data: form } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, sla_minutes, department_id, default_list_id")
    .eq("id", request.form_id)
    .maybeSingle();

  // Gate 1 is offered only while there is a decision left to make. A disabled
  // Approve on an already-decided request invites someone to wire around it.
  const awaitingDecision = request.status === "PENDING_REVIEW";

  // Loaded only when the panel will render — the capacity query is a scan over
  // the department's open tasks and there is no reason to pay for it on a
  // request that was decided last week.
  const [candidates, capacity, decisions, lists, clientFolder] = awaitingDecision
    ? await Promise.all([
        supabase
          .from("vizserve_pms_users")
          .select("id, full_name, role")
          .eq("primary_department_id", form?.department_id ?? "")
          .eq("is_active", true)
          .order("full_name"),
        supabase.rpc("vizserve_pms_department_capacity", {
          p_department_id: form?.department_id ?? "",
          p_target_date: request.target_date,
        }),
        Promise.resolve({ data: null }),
        supabase
          .from("vizserve_pms_lists")
          .select("id, name")
          .eq("department_id", form?.department_id ?? "")
          .eq("is_active", true)
          .order("sort_order")
          .order("name"),
        /*
         * P7-25 — where a list created DURING the approval goes.
         *
         * Without this the inline creator called `saveList` with no `group_id`
         * and the list hung loose under the department, outside every folder —
         * so a lead who made a list for a piece of client work found it filed
         * nowhere near the client work.
         *
         * The reserved folder, by its flag rather than by its name: the name is
         * refused a rename by trigger, but matching on a string would still be
         * matching on a label where a boolean exists.
         */
        supabase
          .from("vizserve_pms_task_groups")
          .select("id")
          .eq("department_id", form?.department_id ?? "")
          .eq("is_system", true)
          .maybeSingle(),
      ])
    : [
        { data: null },
        { data: null },
        await supabase
          .from("vizserve_pms_approvals")
          .select("decision, reason, created_at, approver_id")
          .eq("entity_type", "request")
          .eq("entity_id", id)
          .order("created_at", { ascending: false }),
        { data: null },
        // Fifth slot, matching the branch above. A decided request renders no
        // review panel, so neither the lists nor the folder are ever read —
        // but the tuple has to have the same shape either way.
        { data: null },
      ];

  // Includes archived fields: a historical answer must keep rendering with its
  // label even after the field is retired from the live form (D20/R5).
  const { data: fields } = await supabase
    .from("vizserve_pms_form_fields")
    .select("field_key, label, field_type, is_active")
    .eq("form_id", request.form_id)
    .order("sort_order");

  const { data: attachments } = await supabase
    .from("vizserve_pms_request_attachments")
    .select("id, filename, mime_type, size_bytes, field_key")
    .eq("request_id", id)
    .order("created_at");

  /*
   * P7-59 — THE TASK THIS REQUEST BECAME.
   *
   * Approving at Gate 1 creates a task and then says nothing more about it. The
   * request page carried the submission, a green "Approved" pill and a two-line
   * Decision card, and no route onward at all — so the answer to "what happened
   * to this?" was to go to /tasks and search for the title by eye.
   *
   * ⚠️ ONE QUERY, AND ONLY ONCE THE DECISION IS MADE. A pending request has no
   * task by definition, and this page already refuses to pay for the capacity
   * scan on a request decided last week — the same reasoning applies in reverse.
   *
   * NO DEPARTMENT FILTER. The task policy is WIDER than the request policy — a
   * lead who can open this request necessarily manages the department the task
   * was created in — so RLS returning a row IS the permission check, and
   * restating it here would imply the policy were optional.
   */
  const { data: linkedTask } = awaitingDecision
    ? { data: null }
    : await supabase
        .from("vizserve_pms_tasks")
        .select("id, title, status, assignee_id, qa_assignee_id")
        .eq("request_id", id)
        .maybeSingle();

  /*
   * Names for the three people this card can mention: whoever approved it, and
   * the two the task was handed to.
   *
   * One `in` query rather than three joins — `approver_id` was already being
   * SELECTED by the decisions query above and then never rendered, which is how
   * "Approved · 2 Sep" ended up not saying by whom.
   */
  const peopleIds = [
    decisions?.data?.[0]?.approver_id,
    linkedTask?.assignee_id,
    linkedTask?.qa_assignee_id,
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

  const negotiated = request.approved_target_date && request.approved_target_date !== request.target_date;

  return (
    <PageShell className="mx-auto w-full max-w-4xl">
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={request.reference_no} />

      <div>
        <Link
          href="/requests"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Requests
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{request.reference_no}</h1>
          <RequestStatusBadge status={request.status} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{request.title}</p>
      </div>

      {request.decision_reason ? (
        <div className="rounded-lg border border-info/30 bg-info-subtle p-4">
          <p className="text-xs font-medium text-info">Decision reason</p>
          {/* P7-56. `text-info` has to come through on the wrapper — `RichText`
              sets no colour of its own, so the banner's tone is inherited. */}
          <RichText html={request.decision_reason} className="mt-1 text-info" />
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Requester</CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <Row label="Name">{request.requester_name}</Row>
            {/* Bound at submission and not editable by staff — it is the identity
                used at the Phase 4 client approval gate. */}
            <Row label="Email">
              <a href={`mailto:${request.requester_email}`} className="hover:underline">
                {request.requester_email}
              </a>
            </Row>
            <Row label="Organisation">{request.requester_org}</Row>
            <Row label="Submitted">{formatDateTime(request.submitted_at)}</Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
        </CardHeader>
        <CardContent>
          <dl>
            <Row label="Form">{form?.name ?? "—"}</Row>
            <Row label="Description">
              <RichText html={request.description} />
            </Row>
            <Row label="Target date">
              {formatDate(request.target_date)}
              {isOverdue(request.target_date) && request.status === "PENDING_REVIEW" ? (
                <span className="ml-2 text-xs font-medium text-destructive">Overdue</span>
              ) : null}
            </Row>
            {/* Both dates are kept on purpose: the gap between what the client
                asked for and what was agreed is the metric that proves Gate 1 is
                negotiating rather than rubber-stamping. */}
            {negotiated ? (
              <Row label="Agreed date">
                {formatDate(request.approved_target_date)}
                <span className="ml-2 text-xs text-muted-foreground">negotiated</span>
              </Row>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {fields && fields.length > 0 ? (
        <Card>
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

      <Card>
        <CardHeader>
          <CardTitle>Attachments</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Signed on click, not on render — a URL minted here would sit in the
              page source and in the browser history whether or not anyone opened
              the file. */}
          <AttachmentList attachments={attachments ?? []} />
        </CardContent>
      </Card>

      {awaitingDecision ? (
        <ReviewPanel
          requestId={request.id}
          requestTitle={request.title}
          requestDescription={request.description}
          targetDate={request.target_date}
          referenceNo={request.reference_no}
          requesterName={request.requester_name}
          requesterEmail={request.requester_email}
          requesterOrg={request.requester_org}
          formName={form?.name ?? "a request form"}
          submittedAt={formatDateTime(request.submitted_at)}
          emailJs={emailJsConfig()}
          candidates={candidates.data ?? []}
          capacity={capacity.data ?? []}
          currentUserId={context.userId}
          currentUserName={context.fullName}
          lists={lists?.data ?? []}
          defaultListId={form?.default_list_id ?? null}
          // P7-23. The form's department, not the viewer's: a list created
          // during the review has to belong where the task will.
          departmentId={form?.department_id ?? ""}
          // P7-25. The department's Client Requests folder, so a list made here
          // lands with the client work rather than loose under the department.
          clientFolderId={(clientFolder?.data as { id: string } | null)?.id ?? null}
        />
      ) : decisions?.data && decisions.data.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>
          <CardContent>
            {decisions.data.map((decision) => (
              <div key={decision.created_at} className="space-y-1">
                <p className="text-sm">
                  {/* Never colour alone — the word carries the state. */}
                  <span className="font-medium capitalize">{decision.decision}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {formatDateTime(decision.created_at)}
                    {/* P7-59. `approver_id` was already being selected here and
                        never shown, so the card said what happened and not who
                        did it — the one fact somebody chasing a request needs. */}
                    {nameOf.get(decision.approver_id ?? "")
                      ? ` · ${nameOf.get(decision.approver_id ?? "")}`
                      : null}
                  </span>
                </p>
                {decision.reason ? (
                  // The CLIENT's words on the approval page, not staff markup —
                  // that surface has no editor. Rendered through `RichText`
                  // anyway, because it is the same column shape and the
                  // sanitiser is what makes any of these safe.
                  <RichText
                    html={decision.reason}
                    className="rounded-sm bg-muted/50 px-3 py-2"
                  />
                ) : null}
              </div>
            ))}

            {/*
              P7-59 — WHERE IT WENT.
              
              The end of the Gate 1 story: what was agreed, who is doing it, and
              a way through to the work. Inside the Decision card rather than a
              card of its own, because it is the rest of one sentence — this
              request was approved, on these terms, and became that.
            */}
            {linkedTask ? (
              <dl className="mt-4 border-t pt-1">
                <Row label="Agreed delivery">
                  {formatDate(request.approved_target_date ?? request.target_date)}
                  {/* Same word the Request card above uses for the same fact, so
                      a renegotiated date reads identically in both places. */}
                  {negotiated ? (
                    <span className="ml-2 text-xs text-muted-foreground">negotiated</span>
                  ) : null}
                </Row>

                <Row label="Assigned to">
                  {nameOf.get(linkedTask.assignee_id ?? "") ?? (
                    <span className="text-muted-foreground">Unassigned</span>
                  )}
                  {nameOf.get(linkedTask.qa_assignee_id ?? "") ? (
                    <span className="text-muted-foreground">
                      {" · QA "}
                      {nameOf.get(linkedTask.qa_assignee_id ?? "")}
                    </span>
                  ) : null}
                </Row>

                <Row label="Task">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/tasks/${linkedTask.id}`}
                      className="min-w-0 truncate underline-offset-2 hover:underline">
                      {linkedTask.title}
                    </Link>
                    <TaskStatusBadge status={linkedTask.status} />
                  </span>
                </Row>
              </dl>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

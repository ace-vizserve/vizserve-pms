import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { RequestStatusBadge } from "@/components/status-badge";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
    .select("id, name, sla_days, department_id, default_list_id")
    .eq("id", request.form_id)
    .maybeSingle();

  // Gate 1 is offered only while there is a decision left to make. A disabled
  // Approve on an already-decided request invites someone to wire around it.
  const awaitingDecision = request.status === "PENDING_REVIEW";

  // Loaded only when the panel will render — the capacity query is a scan over
  // the department's open tasks and there is no reason to pay for it on a
  // request that was decided last week.
  const [candidates, capacity, decisions, lists] = awaitingDecision
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

  const values = (request.field_values ?? {}) as Record<string, unknown>;

  function renderValue(raw: unknown): string {
    if (raw === null || raw === undefined || raw === "") return "—";
    if (Array.isArray(raw)) return raw.length > 0 ? raw.join(", ") : "—";
    return String(raw);
  }

  const negotiated =
    request.approved_target_date && request.approved_target_date !== request.target_date;

  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. */}
      <BreadcrumbLabel value={request.reference_no} />

      <div>
        <Link
          href="/requests"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
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
          <p className="mt-1 text-sm text-info">{request.decision_reason}</p>
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
              <p className="whitespace-pre-wrap">{request.description}</p>
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
          candidates={candidates.data ?? []}
          capacity={capacity.data ?? []}
          currentUserId={context.userId}
          currentUserName={context.fullName}
          lists={lists?.data ?? []}
          defaultListId={form?.default_list_id ?? null}
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
                  </span>
                </p>
                {decision.reason ? (
                  <p className="whitespace-pre-wrap rounded-sm bg-muted/50 px-3 py-2 text-sm">
                    {decision.reason}
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

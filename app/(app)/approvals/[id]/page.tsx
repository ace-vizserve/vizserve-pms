import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import type { InternalRequestRow } from "@/lib/database.types";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import { internalRequestLabel, isTimeCorrectionType } from "@/lib/schemas/internal-requests";
import { createClient } from "@/utils/supabase/server";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RichText } from "@/components/ui/rich-text";
import { InternalStatusBadge, InternalTypeBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { DecisionPanel } from "../decision-panel";
import { requestDetail } from "../request-summary";

export const metadata: Metadata = { title: "Request" };

type Row = InternalRequestRow & {
  vizserve_pms_users: { full_name: string; email: string } | null;
  /** Null on every non-LEAVE row, and on LEAVE rows older than P7-12. */
  vizserve_pms_leave_types: { label: string } | null;
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

export default async function InternalRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_internal_requests")
    .select(
      // P7-12 — the leave type comes along as an embed rather than a second
      // query. It is visible HERE, to the requester and to the lead deciding
      // it, and deliberately nowhere else: `vizserve_pms_leave_calendar`
      // returns dates and a name and no type, because "on sick leave" is
      // health information about a named colleague.
      "*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name, email)," +
        " vizserve_pms_leave_types(label)",
    )
    .eq("id", id)
    .maybeSingle();

  /*
   * AN ERROR IS NOT A 404, and conflating them cost an afternoon.
   *
   * This read `const { data } = ...` and threw the error away, so THREE very
   * different situations all rendered as the same bare not-found page:
   *
   *   - the row is outside your scope (correct, and handled below),
   *   - the row does not exist (correct),
   *   - the query FAILED — a missing GRANT, an embed PostgREST could not
   *     resolve, a dropped connection — which is a fault and not a 404 at all.
   *
   * The third is the one this project is most likely to hit: CLAUDE.md opens
   * with "permission denied for table" being a grants diagnosis, and every new
   * migration adds a table or an FK that an embed here could trip over. Silently
   * showing 404 for it sends whoever is debugging to look at RLS, which is
   * exactly where the answer is not.
   */
  if (error) {
    return (
      <PageShell className="mx-auto w-full max-w-3xl">
        <QueryError what="this request" message={error.message} />
      </PageShell>
    );
  }

  // Zero rows through RLS, on the other hand, IS a 404 — and the right thing to
  // leak, because "exists but not for you" is itself information. The scoped
  // not-found.tsx beside this file says which of the two it was.
  if (!data) notFound();

  const request = data as unknown as Row;
  const isOwn = request.requester_id === context.userId;

  // Deciding needs department scope AND not being the requester — the engine
  // and the decide function both re-check this, so what follows is only about
  // whether to render the panel.
  const canDecide =
    !isOwn && request.status === "PENDING_REVIEW" && roleAtLeast(context.role, "team_leader");

  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      {/* Names this page in the shell breadcrumb. Without it the crumb is the
          raw UUID from the URL. An internal request has no reference number, so
          its type is the most identifying thing it has. */}
      <BreadcrumbLabel value={internalRequestLabel(request.request_type)} />

      <Link
        href="/approvals"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All approvals
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {internalRequestLabel(request.request_type)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{requestDetail(request)}</p>
        </div>
        <div className="flex items-center gap-2">
          <InternalTypeBadge type={request.request_type} />
          <InternalStatusBadge status={request.status} />
        </div>
      </div>

      <Card>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label="Requested by" value={request.vizserve_pms_users?.full_name ?? "—"} />
            <Field label="Submitted" value={formatDateTime(request.created_at)} />

            {request.request_type === "LEAVE" ? (
              <>
                {/* Falls back rather than showing nothing: LEAVE rows filed
                    before P7-12 have no type, and the constraint is NOT VALID
                    precisely so those stay readable. */}
                <Field
                  label="Leave type"
                  value={request.vizserve_pms_leave_types?.label ?? "Not recorded"}
                />
                <Field label="First day" value={formatDate(request.start_date)} />
                <Field label="Last day" value={formatDate(request.end_date)} />
              </>
            ) : null}

            {request.request_type === "OVERTIME" ? (
              <>
                <Field label="Day worked" value={formatDate(request.work_date)} />
                <Field
                  label="How long"
                  value={formatCellDuration(request.overtime_minutes ?? 0)}
                />
              </>
            ) : null}

            {isTimeCorrectionType(request.request_type) ? (
              <>
                <Field label="Day being corrected" value={formatDate(request.work_date)} />
                <Field
                  label={
                    request.request_type === "NO_TIME_IN" ||
                    request.request_type === "TIME_IN_CORRECTION"
                      ? "Should have started"
                      : "Should have finished"
                  }
                  value={formatDateTime(request.correction_at)}
                />
              </>
            ) : null}

            {request.request_type === "REIMBURSEMENT" ? (
              <Field label="Amount" value={requestDetail(request)} />
            ) : null}
          </dl>

          <div className="mt-5 border-t pt-4">
            <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Reason</dt>
            <dd className="mt-1">
              <RichText html={request.reason} />
            </dd>
          </div>

          {request.status !== "PENDING_REVIEW" ? (
            <div className="mt-5 border-t pt-4">
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                Decision {request.reviewed_at ? `· ${formatDateTime(request.reviewed_at)}` : ""}
              </dt>
              <dd className="mt-1">
                {request.decision_reason ? (
                  <RichText html={request.decision_reason} />
                ) : (
                  <span className="text-sm text-muted-foreground">No reason given.</span>
                )}
              </dd>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* P5-09, stated on the screen where it matters. Someone deciding a
          correction should know the approval itself rewrites the record — that
          is the difference between this and a chat message saying "ok". */}
      {canDecide ? (
        <>
          {isTimeCorrectionType(request.request_type) ? (
            <p className="rounded-sm border border-info/30 bg-info-subtle px-3 py-2 text-xs">
              Approving this writes {formatDateTime(request.correction_at)} into the DTR for{" "}
              {formatDate(request.work_date)}.
              {/* P7-39. On the two *_CORRECTION types there is already a
                  recorded time, and approving REPLACES it. Saying so is the
                  difference between a lead filling a blank and a lead agreeing
                  to overwrite a machine-captured fact with a colleague's
                  account of it — which is a bigger thing to sign. */}
              {request.request_type === "TIME_IN_CORRECTION" ||
              request.request_type === "TIME_OUT_CORRECTION" ? (
                <span className="font-medium"> This replaces the time already recorded.</span>
              ) : null}
            </p>
          ) : null}
          <DecisionPanel requestId={request.id} />
        </>
      ) : null}

      {isOwn && request.status === "PENDING_REVIEW" ? (
        <p className="text-xs text-muted-foreground">
          Waiting on your department lead. You cannot decide your own request.
        </p>
      ) : null}
    </PageShell>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

import { timesheetWeekHref } from "@/lib/approvals-queue-server";
import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import type { InternalRequestRow, VizservePmsTimesheetWeekStatus } from "@/lib/database.types";
import { formatDate, formatDateTime, formatWeekRange, weeksSpanned } from "@/lib/dates";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import { internalRequestLabel, isTimeCorrectionType } from "@/lib/schemas/internal-requests";
import { createClient } from "@/utils/supabase/server";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RichText } from "@/components/ui/rich-text";
import {
  InternalStatusBadge,
  InternalTypeBadge,
  TimesheetWeekBadge,
} from "@/components/status-badge";
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

  /* Can this reader actually open the destination? Their own week is on
     /timesheet, which every signed-in person reaches; somebody else's is on
     /timesheet/team, which refuses below team_leader. */
  const weeksAreReachable = isOwn || roleAtLeast(context.role, "team_leader");

  /*
   * P8-05 — WHICH TIMESHEET WEEKS THIS LEAVE TOUCHES.
   *
   * Approved leave lowers what a week has to add up to: a member off Monday and
   * Tuesday is submitting against a 24-hour target, not a 40-hour one. Nothing
   * on this screen said so, so a lead reading an approved request had no way to
   * connect it to the short week it explains — and the two live in different
   * modules with no link between them.
   *
   * A READ AND A LINK, and deliberately nothing more. No foreign key: leave is
   * dated and weeks are keyed by Monday, and a stored pointer between them would
   * have to be maintained on every edit of either. `weeksSpanned` derives the
   * Mondays from the dates already on this row, which is arithmetic, not state.
   *
   * ⚠️ IT DOES NOT RESTATE THE TARGET. The rule that turns a schedule plus days
   * off into a weekly minimum lives in `scheduledWeekMinutes` and in
   * `vizserve_pms_submit_timesheet_week`; a third copy printed here would be a
   * third thing to keep in step, and the week itself shows the figure.
   */
  const affectedWeeks =
    request.request_type === "LEAVE" && request.start_date && request.end_date
      ? weeksSpanned(request.start_date, request.end_date)
      : [];

  /*
   * The status of each of those weeks, for the person who filed the leave.
   *
   * No department filter — the weeks policy scopes by the department snapshotted
   * at submission, exactly as it does on `/timesheet/team`. A lead outside that
   * scope simply gets no rows back and the links still render, which is the
   * correct outcome: the week EXISTS whether or not this reader may see it.
   */
  const { data: weekRows, error: weeksError } =
    affectedWeeks.length > 0
      ? await supabase
          .from("vizserve_pms_timesheet_weeks")
          .select("id, week_start, status")
          .eq("user_id", request.requester_id)
          .in("week_start", affectedWeeks)
      : { data: null, error: null };

  const weekStatus = new Map(
    (weekRows ?? []).map((week) => [week.week_start, week.status as VizservePmsTimesheetWeekStatus]),
  );

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

          {/* P8-05 — the link the two modules never had between them. A leave
              request and the timesheet week it shortens are the same fact seen
              from two screens, and only one of them said so. */}
          {affectedWeeks.length > 0 ? (
            <div className="mt-5 border-t pt-4">
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                Timesheet {affectedWeeks.length === 1 ? "week" : "weeks"} affected
              </dt>
              <dd className="mt-2 space-y-1.5">
                {affectedWeeks.map((monday) => (
                  <div key={monday} className="flex flex-wrap items-center gap-2">
                    {weeksAreReachable ? (
                      <Link
                        /* Your own week is on your own timesheet; somebody else's
                           is on the team grid, which is also the only place it can
                           be decided. Same destination the approvals queue uses. */
                        href={isOwn ? `/timesheet?week=${monday}` : timesheetWeekHref(monday)}
                        className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                      >
                        {formatWeekRange(monday)}
                        <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
                      </Link>
                    ) : (
                      /* ⚠️ NOT A LINK FOR SOMEBODY THE DESTINATION WOULD REFUSE.
                         `/timesheet/team` is `requireRole("team_leader")`, and HR
                         is a TICK rather than a rank (D33) — p7_54 lets an
                         HR-ticked MEMBER read a colleague's leave request, so
                         they reach this panel while that page throws at them.
                         The week is still worth naming; the door is not worth
                         offering. Hiding a link protects nobody, but offering a
                         dead one is a promise the next click breaks. */
                      <span className="text-sm font-medium">{formatWeekRange(monday)}</span>
                    )}
                    {/* ⚠️ "Not handed in" also covers a week this reader cannot
                        see — the weeks policy scopes by the department
                        snapshotted at submission, which can differ from the one
                        on this request if somebody moved teams. The week exists
                        either way, so the link stays and only the badge goes. */}
                    {weekStatus.get(monday) ? (
                      <TimesheetWeekBadge status={weekStatus.get(monday)!} />
                    ) : (
                      <span className="text-xs text-muted-foreground">Not handed in</span>
                    )}
                  </div>
                ))}

                {/* No figures. The week itself does the arithmetic — see the
                    note on the read above. */}
                <p className="pt-1 text-xs text-muted-foreground">
                  {request.status === "APPROVED"
                    ? "Approved leave lowers what these weeks have to add up to, so a short week here is expected. Open one to see what it now needs."
                    : "If this is approved, these weeks will need correspondingly fewer hours."}
                </p>

                {/* Degraded, not fatal: the links above are derived from dates on
                    this row and are correct whether or not this read landed. Only
                    the badges are missing, and saying so beats a row that quietly
                    reads "Not handed in" for every week. */}
                {weeksError ? (
                  <p className="text-xs text-warning">
                    Could not check whether these weeks have been handed in: {weeksError.message}
                  </p>
                ) : null}
              </dd>
            </div>
          ) : null}

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

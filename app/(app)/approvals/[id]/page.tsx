import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

import { timesheetWeekHref, waitingOnMe } from "@/lib/approvals-queue-server";
import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import type { InternalRequestRow, VizservePmsTimesheetWeekStatus } from "@/lib/database.types";
import { formatDate, formatDateTime, formatWeekRange, weeksSpanned } from "@/lib/dates";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import {
  APPROVAL_STAGE_LABELS,
  APPROVAL_STAGE_NAMES,
  type ApprovalStage,
  TURNOVER_CONFIRMATION_TEXT,
  internalRequestLabel,
  isTimeCorrectionType,
} from "@/lib/schemas/internal-requests";
import { cn } from "@/lib/utils";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DecisionPanel } from "../decision-panel";
import { requestDetail } from "../request-summary";
import { WithdrawButton } from "../withdraw-button";

/**
 * P9-01 — one reliever, their answer, and what they are taking on.
 *
 * ⚠️ THE EMBED CONSTRAINT IS NAMED, and it has to be.
 * `vizserve_pms_internal_request_relievers` has one FK to
 * `vizserve_pms_users`, so an unqualified embed resolves today — but the
 * pattern that broke `vizserve_pms_timesheet_weeks` with PGRST201 is a SECOND
 * FK arriving later, and the failure takes the whole query rather than the
 * column. Naming it costs nothing now and cannot break then.
 */
type RelieverRow = {
  id: string;
  reliever_id: string;
  decision: "approved" | "returned" | "rejected" | null;
  decided_at: string | null;
  reason: string | null;
  vizserve_pms_users: { full_name: string } | null;
  vizserve_pms_internal_request_reliever_tasks: Array<{
    task_id: string;
    vizserve_pms_tasks: { id: string; title: string } | null;
  }>;
};

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
  /*
   * TWO READS, ONE WAVE. The relievers read was awaited AFTER this one and
   * needs nothing from it — it is keyed by the `id` from the URL, which has
   * been in hand since the first line of this function. The weeks read still
   * genuinely waits on the request row (it is derived from its dates), so the
   * ternary below is untouched: no query runs that did not run before, and on
   * a request with no affected weeks the slot is still the same inert literal.
   */
  const [{ data: weekRows, error: weeksError }, { data: relieverRows }] = await Promise.all([
    affectedWeeks.length > 0
      ? supabase
          .from("vizserve_pms_timesheet_weeks")
          .select("id, week_start, status")
          .eq("user_id", request.requester_id)
          .in("week_start", affectedWeeks)
      : { data: null, error: null },

    /*
     * P9-01 — the hand-over, if there is one.
     *
     * Read for every request rather than only for chained leave: a request that
     * has been approved keeps its relievers, and the page that shows who covered
     * what should still show it afterwards. An unchained request simply gets an
     * empty array, which renders as nothing.
     *
     * The names come through an embed on the same read. Policy-scoped like
     * everything else — a reliever can see their own row, and the requester, the
     * leads and HR can see them all.
     */
    supabase
      .from("vizserve_pms_internal_request_relievers")
      .select(
        "id, reliever_id, decision, decided_at, reason, vizserve_pms_users!vizserve_pms_internal_request_relievers_reliever_id_fkey(full_name), vizserve_pms_internal_request_reliever_tasks(task_id, vizserve_pms_tasks(id, title))",
      )
      .eq("request_id", id)
      .order("created_at", { ascending: true }),
  ]);

  const weekStatus = new Map(
    (weekRows ?? []).map((week) => [week.week_start, week.status as VizservePmsTimesheetWeekStatus]),
  );

  const relievers = (relieverRows ?? []) as unknown as RelieverRow[];

  /*
   * ⚠️ P9-04 — DECIDING IS NO LONGER A QUESTION ABOUT YOUR ROLE.
   *
   * This was `!isOwn && PENDING_REVIEW && roleAtLeast(role, "team_leader")`,
   * which was right for a single decision by a department lead and is wrong in
   * both directions now:
   *
   *   * A RELIEVER is usually a plain `member`. The role test hid the panel
   *     from the one person the request was actually waiting for.
   *   * A STAGE-3 MANAGER may lead no department at all, and a lead who can see
   *     a stage-1 request must not be offered a button for it.
   *
   * `waitingOnMe` is the shared rule — the same one the approvals queue and the
   * dashboard tile use, so the list that sent somebody here and the panel they
   * find cannot disagree. The decide function re-checks all of it; this only
   * decides whether to render.
   */
  const owedAsReliever = new Set(
    relievers
      .filter((row) => row.reliever_id === context.userId && row.decision === null)
      .map(() => request.id),
  );

  const canDecide =
    request.status === "PENDING_REVIEW" && waitingOnMe(request, context, owedAsReliever);

  /*
   * P9-03 — may the author take it back?
   *
   * Only while NOBODY has answered. Not "while it is pending": a leave request
   * whose three relievers have all accepted is still PENDING_REVIEW, and
   * pulling it out from under people who have already signed is the surprise
   * this rule exists to prevent. `vizserve_pms_withdraw_internal_request`
   * enforces it against both decision logs; this mirrors the reliever half,
   * which is the one visible from here.
   */
  const anyRelieverAnswered = relievers.some((row) => row.decision !== null);
  const canWithdraw =
    isOwn &&
    request.status === "PENDING_REVIEW" &&
    !anyRelieverAnswered &&
    (request.approval_stage ?? 0) <= 2;

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
      {/*
        P9-01 — THE HAND-OVER AND WHERE THE REQUEST HAS GOT TO.

        Shown to everybody who can see the request, not only to whoever is
        deciding it: the requester needs to know who is still owed, and a
        reliever who has already accepted needs to see that they are waiting on
        a colleague rather than on themselves.
      */}
      {(request.approval_stage ?? 0) > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Approval</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* The stage list. Only the stages this request actually has —
                non-reliever leave opens at 2 and never had a reliever stage, so
                drawing an empty "Relievers" step for it would invent one. */}
            <ol className="space-y-2 text-xs">
              {([1, 2, 3] as const)
                .filter((stage) => stage > 1 || relievers.length > 0)
                .map((stage) => {
                  const current = request.approval_stage === stage;
                  // Terminal statuses stop the chain wherever it stood, so
                  // "past" is only meaningful while it is still moving.
                  const past =
                    request.status === "APPROVED" || (request.approval_stage ?? 0) > stage;
                  return (
                    <li key={stage} className="flex items-baseline gap-2">
                      {/* State is never conveyed by colour alone — every step
                          carries the word for where it stands. */}
                      <span
                        className={cn(
                          "min-w-24 font-medium",
                          current && "text-foreground",
                          !current && "text-muted-foreground",
                        )}
                      >
                        {APPROVAL_STAGE_NAMES[stage]}
                      </span>
                      <span className="text-muted-foreground">
                        {request.status === "REJECTED" && current
                          ? "Rejected here"
                          : request.status === "WITHDRAWN" && current
                            ? "Withdrawn before this"
                            : past
                              ? "Done"
                              : current
                                ? "Waiting"
                                : "Not yet"}
                      </span>
                    </li>
                  );
                })}
            </ol>

            {relievers.length > 0 ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium">Relievers</p>
                {relievers.map((row) => (
                  <div key={row.id} className="space-y-1 rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {row.vizserve_pms_users?.full_name ?? "A colleague"}
                      </span>
                      <span className="text-muted-foreground">
                        {row.decision === "approved"
                          ? `Accepted ${formatDate(row.decided_at)}`
                          : row.decision === "rejected"
                            ? `Declined ${formatDate(row.decided_at)}`
                            : "Not answered yet"}
                      </span>
                    </div>
                    <ul className="list-inside list-disc text-muted-foreground">
                      {row.vizserve_pms_internal_request_reliever_tasks.map((link) => (
                        <li key={link.task_id}>
                          <Link
                            href={`/tasks/${link.task_id}`}
                            className="hover:text-foreground hover:underline"
                          >
                            {link.vizserve_pms_tasks?.title ?? "A task"}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {row.reason ? (
                      <p className="text-muted-foreground">{row.reason}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {/* The attestation, recorded rather than assumed. It is a claim the
                requester made, and the people approving are approving it. */}
            {request.turnover_confirmed_at ? (
              <p className="border-t pt-3 text-xs text-muted-foreground">
                Turn-over confirmed on {formatDate(request.turnover_confirmed_at)}:{" "}
                <span className="italic">{TURNOVER_CONFIRMATION_TEXT}</span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {canDecide ? (
        <>
          {/* P9-01. A reliever is not approving leave — they are agreeing to
              hold four named tasks — and the panel below says "Approve". The
              sentence is what makes the button mean the right thing. */}
          {request.approval_stage === 1 ? (
            <p className="rounded-sm border border-info/30 bg-info-subtle px-3 py-2 text-xs">
              You have been asked to cover the tasks listed above while this person is away.
              Approving means you take them on for the dates shown; declining sends the whole
              request back and needs a reason.
            </p>
          ) : null}
          {request.approval_stage === 3 ? (
            <p className="rounded-sm border border-info/30 bg-info-subtle px-3 py-2 text-xs">
              Their team leader has approved this. Yours is the last signature.
            </p>
          ) : null}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {/* P9-04. "Waiting on your department lead" was true of every
                request until the chain and is now true of some of them. Saying
                it of one sitting with three relievers sends the requester to
                chase the wrong person. */}
            {APPROVAL_STAGE_LABELS[(request.approval_stage ?? 0) as ApprovalStage]}. You cannot
            decide your own request.
          </p>
          {/* P9-03. Only while nobody has answered — see `canWithdraw`. Once
              somebody has, the way out is a rejection, which is their decision
              and reads as one. */}
          {canWithdraw ? <WithdrawButton requestId={request.id} /> : null}
        </div>
      ) : null}
    </PageShell>
  );
}

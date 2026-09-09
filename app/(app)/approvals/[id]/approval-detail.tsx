"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

import { timesheetWeekHref, waitingOnMe } from "@/lib/approvals-queue";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTimesheetWeekStatus } from "@/lib/database.types";
import {
  formatDate,
  formatDateTime,
  formatWeekRange,
  todayInAppZone,
  weeksSpanned,
} from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchAffectedWeeks,
  fetchApprovalChain,
  fetchApprovalDetail,
} from "@/lib/query/fetchers/approvals";
import { qk } from "@/lib/query/keys";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import type {
  ApprovalsViewer,
  InternalDecisionRow,
} from "@/lib/schemas/internal-approvals";
import {
  APPROVAL_STAGE_LABELS,
  APPROVAL_STAGE_NAMES,
  type ApprovalStage,
  TURNOVER_CONFIRMATION_TEXT,
  internalRequestLabel,
  isTimeCorrectionType,
} from "@/lib/schemas/internal-requests";
import { StageTrack, metaDate, metaLine, type Step } from "@/components/stage-track";
import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { CardSkeleton } from "@/components/skeletons";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RichTextClient } from "@/components/ui/rich-text-client";
import {
  ApprovalDecisionBadge,
  InternalStatusBadge,
  InternalTypeBadge,
  TimesheetWeekBadge,
} from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { DecisionPanel } from "../decision-panel";
import { requestDetail } from "../request-summary";
import { WithdrawButton } from "../withdraw-button";

/**
 * P5-10 / P12-19 — one internal request, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * WHAT MOVED, AND WHAT DID NOT.
 *
 * This was an RSC: a row with two embeds, then a wave of three — the relievers,
 * the decision history and (on a leave request) the weeks it touches — all
 * behind ONE cache entry, the route's own render. Deciding it called
 * `revalidatePath` on `/approvals`, `/`, `/dashboard`, `/inbox` and this route.
 * The reads are three query keys now, and a decision sweeps `["approval"]`.
 *
 * ⚠️ EVERY DERIVATION BELOW IS THE ORIGINAL, LINE FOR LINE. The stage rail, the
 * `signed` test, the two withdrawal routes, `canDecide` — none of them changed
 * on the way, because every one is a rule somebody argued for once and wrote
 * down. What changed is where `request`, `relievers`, `decisions` and the week
 * statuses come from.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `waitingOnMe` runs here against
 * the `viewer` `page.tsx` resolved — the SAME function the approvals queue and
 * the dashboard tile use, so the list that sent somebody here and the panel they
 * find cannot disagree. `lib/auth/authorization.ts` is `server-only`, which is
 * why the three fields it needs travel as a prop rather than being asked for.
 * The decide function re-checks all of it; this only decides whether to render.
 *
 * ⚠️ AND AN ERROR IS STILL NOT A 404. The RSC's own comment records an afternoon
 * spent on that: it read `const { data } = ...`, threw the error away, and
 * rendered the same bare not-found page for an out-of-scope row, a missing row
 * and a FAILED query — sending whoever was debugging to look at RLS, which is
 * exactly where the answer was not. `read()` throwing is what keeps them apart,
 * and the branch order below is the whole of it.
 * ------------------------------------------------------------------------
 */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

export function ApprovalDetailView({
  requestId,
  viewer,
}: {
  requestId: string;
  /** Every role and department decision, made on the server. See `page.tsx`. */
  viewer: ApprovalsViewer;
}) {
  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie`.
   */
  const requestQuery = useQuery({
    queryKey: qk.approval(requestId),
    queryFn: () => fetchApprovalDetail(browserClient(), requestId),
  });

  const request = requestQuery.data ?? null;

  /*
   * The relievers and the signatures.
   *
   * ⚠️ NOT GATED BEHIND THE ROW, unlike the weeks below. Both reads are keyed by
   * the `id` from the URL and neither needs a field off the request — the RSC
   * awaited the row first only because it was written as one sequence. Firing
   * them together is the whole point of moving off a route render.
   */
  const chainQuery = useQuery({
    queryKey: qk.approvalPart(requestId, "chain"),
    queryFn: () => fetchApprovalChain(browserClient(), requestId),
  });

  const relievers = chainQuery.data?.relievers ?? [];
  const decisions = chainQuery.data?.decisions ?? [];

  /*
   * P8-05 — WHICH TIMESHEET WEEKS THIS LEAVE TOUCHES.
   *
   * Approved leave lowers what a week has to add up to: a member off Monday and
   * Tuesday is submitting against a 24-hour target, not a 40-hour one. Nothing
   * on this screen said so, so a lead reading an approved request had no way to
   * connect it to the short week it explains.
   *
   * ⚠️ A GENUINE DEPENDENCY ON THE ROW, because the Mondays are DERIVED from its
   * dates. `weeksSpanned` is arithmetic, not state — there is no foreign key
   * between leave and weeks, and a stored pointer would have to be maintained on
   * every edit of either.
   */
  const affectedWeeks =
    request?.request_type === "LEAVE" && request.start_date && request.end_date
      ? weeksSpanned(request.start_date, request.end_date)
      : [];

  const weeksQuery = useQuery({
    queryKey: qk.approvalPart(requestId, "weeks"),
    queryFn: () => fetchAffectedWeeks(browserClient(), request!.requester_id, affectedWeeks),
    enabled: Boolean(request) && affectedWeeks.length > 0,
  });

  const weekStatus = new Map(
    (weeksQuery.data ?? []).map((week) => [
      week.week_start,
      week.status as VizservePmsTimesheetWeekStatus,
    ]),
  );

  /*
   * ⚠️ ERROR BEFORE PENDING, AND `notFound()` BETWEEN THEM — see the file
   * header. A failed read must not render as "this request does not exist".
   */
  if (requestQuery.isError) {
    return (
      <PageShell className="mx-auto w-full max-w-3xl">
        <QueryError what="this request" message={requestQuery.error.message} />
      </PageShell>
    );
  }

  if (requestQuery.isPending) {
    return (
      <PageShell className="mx-auto w-full max-w-3xl">
        <CardSkeleton lines={5} />
      </PageShell>
    );
  }

  // Zero rows through RLS IS a 404 — and the right thing to leak, because
  // "exists but not for you" is itself information. The scoped `not-found.tsx`
  // beside this file says which of the two it was.
  if (!request) notFound();

  const isOwn = request.requester_id === viewer.userId;

  /* Can this reader actually open the destination? Their own week is on
     /timesheet, which every signed-in person reaches; somebody else's is on
     /timesheet/team, which refuses below team_leader.

     ⚠️ `roleAtLeast` FROM `lib/auth/roles.ts`, WHICH IS THE ONE MODULE WITH THE
     ROLE ORDER AND NO `server-only`. Not a re-implementation and not a second
     copy — CLAUDE.md's rule is that scoping goes through one place, and this is
     the client-safe half of it. */
  const weeksAreReachable = isOwn || roleAtLeast(viewer.role, "team_leader");

  /* Degraded, not fatal — the links are derived from dates on this row and are
     correct whether or not the statuses landed. Only the badges are missing. */
  const weeksError = weeksQuery.isError ? weeksQuery.error : null;

  /*
   * WHICH DECISION BELONGS TO WHICH STAGE, and the answer is their ORDER.
   *
   * ⚠️ `vizserve_pms_approvals` HAS NO STAGE COLUMN, and it should not grow one
   * — P2-00 keeps it generic on purpose so timesheet weeks and client requests
   * share it. What makes position sufficient is that the engine writes exactly
   * one row per stage, in order: stage 2 calls `record_decision` and advances,
   * stage 3 calls it again and closes. Stage 1 writes none at all — a reliever's
   * answer lives on their own row, and is read above.
   *
   * A rejection is terminal at every stage (p9_04), so there can never be a
   * third row, and never a second one on a request that was refused at stage 2.
   */
  const stageDecision = (stage: 2 | 3) => decisions[stage - 2] ?? null;

  /** The name only resolves for readers the `p11_01` users policy admits. */
  const decidedBy = (row: InternalDecisionRow | null) => row?.vizserve_pms_users?.full_name ?? null;

  /*
   * THE RAIL. One stop per stage this request actually has.
   *
   * ⚠️ STAGE 1 IS DRAWN ONLY WHEN THERE ARE RELIEVERS. Non-reliever leave opens
   * at stage 2 and never had a hand-over stage, so a greyed-out "Relievers" step
   * would invent one and report the request as further from done than it is —
   * the same failure `GateTrack` warns about for a Gate 3 on internal work.
   *
   * ⚠️ `meta` IS ONE SHORT LINE, so it carries WHO and WHEN and never the
   * reason. A rejection reason is a paragraph somebody wrote; putting it here
   * would either truncate it or wreck the rail. The reasons are listed below
   * instead — the same split the task page makes between its track and its
   * history card: "where is this" and "what happened to it" are two questions.
   */
  const chainSteps: Step[] = ([1, 2, 3] as const)
    .filter((stage) => stage > 1 || relievers.length > 0)
    .map((stage) => {
      const label = APPROVAL_STAGE_NAMES[stage];
      const current = request.approval_stage === stage;
      // Terminal statuses stop the chain wherever it stood, so "past" is only
      // meaningful while it is still moving.
      const past = request.status === "APPROVED" || (request.approval_stage ?? 0) > stage;

      if (request.status === "WITHDRAWN" && current) {
        return { label, state: "pending", meta: "Withdrawn before this" };
      }

      if (stage === 1) {
        const declined = relievers.find((row) => row.decision === "rejected") ?? null;
        if (declined) {
          return {
            label,
            state: "attention",
            meta: metaLine(
              "Declined",
              metaDate(declined.decided_at),
              declined.vizserve_pms_users?.full_name,
            ),
          };
        }
        const answered = relievers.filter((row) => row.decision !== null).length;
        return {
          label,
          state: past ? "done" : current ? "current" : "pending",
          // A count, not names: the names are spelled out in full underneath,
          // and three of them do not fit on a rail.
          meta: past
            ? `All ${relievers.length} accepted`
            : current
              ? `${answered} of ${relievers.length} answered`
              : null,
        };
      }

      const row = stageDecision(stage);

      if (request.status === "REJECTED" && current) {
        return {
          label,
          state: "attention",
          meta: metaLine("Rejected", metaDate(row?.created_at), decidedBy(row)),
        };
      }
      if (past) {
        return { label, state: "done", meta: metaLine(metaDate(row?.created_at), decidedBy(row)) };
      }
      return { label, state: current ? "current" : "pending", meta: current ? "Waiting" : null };
    });


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
      .filter((row) => row.reliever_id === viewer.userId && row.decision === null)
      .map(() => request.id),
  );

  const canDecide =
    request.status === "PENDING_REVIEW" && waitingOnMe(request, viewer, owedAsReliever);

  /*
   * P9-03 / P11-13 — may the author take it back?
   *
   * TWO ROUTES, and which one applies turns on whether anybody has signed.
   *
   *   nobody has  — P9-03 unchanged. Any type, any date, note optional.
   *   somebody has — P11-13. LEAVE ONLY, and only before its first day. Every
   *                  consequence of approved leave is a `status = 'APPROVED'`
   *                  filter elsewhere, so withdrawing it undoes all of them and
   *                  leaves nothing half-undone. Nothing else in this module is
   *                  like that: approving a correction or overtime rewrites a
   *                  DTR row, which a status flip does not reach.
   *
   * `vizserve_pms_withdraw_internal_request` enforces all of it. This only
   * decides whether to render a button, and it is deliberately no more generous
   * than the function — an offered control that fails on click is worse than an
   * absent one.
   */
  const anyRelieverAnswered = relievers.some((row) => row.decision !== null);

  /*
   * ⚠️ `approval_stage > 2` IS IN HERE ON PURPOSE, and it is not redundant with
   * `decisions`. The approvals read is scoped by the `p11_01` audience rule, so
   * a requester who cannot see the rows gets an empty array — and reading that
   * as "nobody has signed" would offer a note-less withdrawal on a request a
   * team leader had already approved. The stage lives on the request row, which
   * the requester can always read, and stage 3 can only be reached by a
   * signature at stage 2.
   */
  const signed =
    request.status === "APPROVED" ||
    anyRelieverAnswered ||
    decisions.length > 0 ||
    (request.approval_stage ?? 0) > 2;

  const canWithdraw =
    isOwn &&
    (signed
      ? (request.status === "APPROVED" || request.status === "PENDING_REVIEW") &&
        request.request_type === "LEAVE" &&
        Boolean(request.start_date) &&
        // String comparison, because both sides are bare `YYYY-MM-DD` and that
        // sorts correctly. Parsing them would drag in the midday-UTC rule
        // `lib/dates.ts` exists to contain, for no gain.
        request.start_date! > todayInAppZone()
      : request.status === "PENDING_REVIEW");

  /* The database requires a note on this route; the dialog says so up front
     rather than letting somebody write nothing and be refused. */
  const withdrawNeedsNote = signed;

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
              <RichTextClient html={request.reason} />
            </dd>
          </div>

          {/*
           * P11-13 — A WITHDRAWAL IS NOT A DECISION, so it is not filed under
           * one. This block used to be the "Decision" block below, which read
           * "Decision · No reason given" on every withdrawn request: a heading
           * naming an act nobody performed, over a sentence blaming somebody
           * for not explaining it.
           *
           * `withdrawn_note` is the REQUESTER's own words and `decision_reason`
           * is an approver's. They are different columns for that reason and
           * they get different headings for the same one.
           */}
          {request.status === "WITHDRAWN" ? (
            <div className="mt-5 border-t pt-4">
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Withdrawn</dt>
              <dd className="mt-1">
                {request.withdrawn_note ? (
                  <RichTextClient html={request.withdrawn_note} />
                ) : (
                  // Not "no reason given". Nobody was owed one — see P9-03.
                  <span className="text-sm text-muted-foreground">
                    Taken back by {request.vizserve_pms_users?.full_name ?? "the requester"}, with
                    no note.
                  </span>
                )}
                {/*
                 * P11-13 — WITHDRAWN FROM APPROVED, which `status` alone cannot
                 * say. `reviewed_at` survives the withdrawal precisely so this
                 * line can exist: a request that was signed off and then taken
                 * back reads completely differently from one nobody ever
                 * looked at, and anyone auditing the leave calendar for a gap
                 * needs to see which of the two this was.
                 */}
                {request.reviewed_at ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    It had been approved on {formatDateTime(request.reviewed_at)}, and was taken
                    back before it started.
                  </p>
                ) : null}
              </dd>
            </div>
          ) : request.status !== "PENDING_REVIEW" ? (
            <div className="mt-5 border-t pt-4">
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                Decision {request.reviewed_at ? `· ${formatDateTime(request.reviewed_at)}` : ""}
              </dt>
              <dd className="mt-1">
                {request.decision_reason ? (
                  <RichTextClient html={request.decision_reason} />
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
            {/* ⚠️ `StageTrack`, THE SAME COMPONENT THE TASK PAGE DRAWS ITS GATES
                WITH. This used to be a hand-rolled `<ol>` that could show a role
                and one of five adverbs — "Team leader · Done" — with nowhere to
                put a name or a date. The shared rail has a `meta` slot, four
                marker states with distinct shapes, and an `sr-only` word for
                each, so none of this is carried by colour. */}
            <StageTrack steps={chainSteps} className="p-0" />

            {/*
              WHAT EACH SIGNATORY WROTE.

              ⚠️ THE RAIL ANSWERS "WHERE IS THIS"; THIS ANSWERS "WHAT HAPPENED".
              Keeping them apart is deliberate and is the same split the task
              page makes between `GateTrack` and its History card. A reason is a
              paragraph; a rail is one line per stop. Merging them truncates the
              first or wrecks the second.

              Shown to everyone who can read the request, reasons included — the
              audience rule `p11_01` encodes. The requester needs the reason most
              of all: a rejection with no visible cause gets refiled unchanged
              and refused again.
            */}
            {decisions.length > 0 ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium">Decisions</p>
                {decisions.map((row) => (
                  <div key={row.created_at} className="space-y-1 rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {/* A reader entitled to the decision may not be entitled
                            to the person. Saying so beats an empty space that
                            reads as a rendering fault. */}
                        {row.vizserve_pms_users?.full_name ?? "Somebody outside your scope"}
                      </span>
                      <span className="flex items-center gap-2">
                        <ApprovalDecisionBadge decision={row.decision} />
                        <span className="text-muted-foreground">
                          {formatDateTime(row.created_at)}
                        </span>
                      </span>
                    </div>
                    {row.reason ? (
                      <RichTextClient html={row.reason} className="text-muted-foreground" />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {relievers.length > 0 ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium">Relievers</p>
                {relievers.map((row) => (
                  <div key={row.id} className="space-y-1 rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {row.vizserve_pms_users?.full_name ?? "A colleague"}
                      </span>
                      {/* ⚠️ `ApprovalDecisionBadge`, NOT TWO HAND-WRITTEN WORDS.
                          It has existed since P2-00 with a per-decision icon and
                          was used only by the client-request page, while this
                          one rendered the strings "Accepted" and "Declined" — a
                          status told by wording alone, in the one file whose
                          header insists every status carries its chip.
                          `formatDateTime`, not `formatDate`, because the rest of
                          this page gives the time of day and a hand-over that
                          landed at 16:55 is not the same fact as one that landed
                          at 09:00. */}
                      {row.decision ? (
                        <span className="flex items-center gap-2">
                          <ApprovalDecisionBadge decision={row.decision} />
                          <span className="text-muted-foreground">
                            {formatDateTime(row.decided_at)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not answered yet</span>
                      )}
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

      {isOwn && (request.status === "PENDING_REVIEW" || canWithdraw) ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {request.status === "PENDING_REVIEW" ? (
              <>
                {/* P9-04. "Waiting on your department lead" was true of every
                    request until the chain and is now true of some of them.
                    Saying it of one sitting with three relievers sends the
                    requester to chase the wrong person. */}
                {APPROVAL_STAGE_LABELS[(request.approval_stage ?? 0) as ApprovalStage]}. You cannot
                decide your own request.
              </>
            ) : (
              /* P11-13. The window, stated, because it closes on a date rather
                 than on an event the requester can see coming. Somebody who
                 discovers on the Tuesday morning that the button has gone
                 should have been told on the Monday that it would. */
              <>Approved. You can still take it back until {formatDate(request.start_date)}.</>
            )}
          </p>
          {/* P9-03 / P11-13 — see `canWithdraw` for which of the two routes
              this is. The dialog changes its own words based on the same
              question the note requirement turns on. */}
          {canWithdraw ? (
            <WithdrawButton requestId={request.id} needsNote={withdrawNeedsNote} />
          ) : null}
        </div>
      ) : null}
    </PageShell>
  );
}

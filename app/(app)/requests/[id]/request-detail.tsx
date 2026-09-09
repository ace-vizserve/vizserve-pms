"use client";

import { ArrowLeft, ChevronRight, ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { CardSkeleton } from "@/components/skeletons";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import {
  ApprovalDecisionBadge,
  RequestStatusBadge,
  TaskStatusBadge,
} from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RichTextClient } from "@/components/ui/rich-text-client";
import { formatDate, formatDateTime, isOverdue } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchRequestContext,
  fetchRequestDetail,
  fetchRequestOutcome,
} from "@/lib/query/fetchers/requests";
import { qk } from "@/lib/query/keys";

import { AttachmentList } from "./attachment-list";
import { ReviewPanel } from "./review-panel";

/**
 * P1-14 / P12-18 — request detail, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was an RSC in four sequential waves: the request row, then a batch of
 * five keyed by its `form_id`, then a wave of four keyed by the form's
 * `department_id`, then a names query keyed by the ids the third wave returned —
 * all behind ONE cache entry, the route's own render. Deciding at Gate 1 then
 * called `revalidatePath` on this route, on `/requests`, on `/` and on
 * `/dashboard`, so one decision re-ran every one of them from the top.
 *
 * The reads are four query keys now (`lib/query/fetchers/requests.ts` argues
 * which owns which) and the two sequential dependencies that are REAL are still
 * sequential: the context needs `form_id` off the row, and the review context
 * needs `department_id` off the form. Both are expressed as `enabled` rather
 * than as an `await`, so the parts that do not depend on them paint first.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireRole("team_leader")` runs
 * in `page.tsx` beside this, and the reviewer's own id and name come down as
 * props — the QA field defaults to the approving TL (P2-05), and who that is
 * belongs with the session, not with a query.
 *
 * ⚠️ AND THE `notFound()` DISTINCTION IS PRESERVED, WHICH IS THE PART MOST
 * EASILY LOST. The RSC's own comment records an afternoon spent on it: an ERROR
 * IS NOT A 404. Out of scope returns no row under RLS and IS a 404 — the right
 * thing to leak, because "exists but not for you" is itself information. A
 * FAILED query is a fault and gets `QueryError`, because sending whoever is
 * debugging to look at RLS is exactly where the answer is not. `read()` throwing
 * is what makes the two separable at all; the RSC discarded the error and could
 * not tell them apart.
 * ------------------------------------------------------------------------
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b py-2.5 last:border-0 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

function renderValue(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  if (Array.isArray(raw)) return raw.length > 0 ? raw.join(", ") : "—";
  return String(raw);
}

export function RequestDetailView({
  requestId,
  currentUserId,
  currentUserName,
}: {
  requestId: string;
  /** P2-05 — the QA field defaults to the approving TL. From the session. */
  currentUserId: string;
  currentUserName: string;
}) {
  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie` — which is why
   * that helper is lazy. A `queryFn` only ever runs in the browser.
   */
  const requestQuery = useQuery({
    queryKey: qk.request(requestId),
    queryFn: () => fetchRequestDetail(browserClient(), requestId),
  });

  const request = requestQuery.data ?? null;

  // Gate 1 is offered only while there is a decision left to make. A disabled
  // Approve on an already-decided request invites someone to wire around it.
  const awaitingDecision = request?.status === "PENDING_REVIEW";

  /*
   * The form, its field labels and the files.
   *
   * ⚠️ A GENUINE SEQUENTIAL DEPENDENCY, EXPRESSED AS `enabled` RATHER THAN AN
   * AWAIT. It is keyed by `form_id`, which does not exist until the row lands —
   * the RSC awaited the row and then this batch for the same reason. The
   * difference is that the requester card and the decision reason paint the
   * moment the row arrives, instead of waiting behind a query neither of them
   * reads.
   */
  const contextQuery = useQuery({
    queryKey: qk.requestPart(requestId, "context"),
    queryFn: () => fetchRequestContext(browserClient(), requestId, request!.form_id),
    enabled: Boolean(request?.form_id),
  });

  const form = contextQuery.data?.form ?? null;
  const fields = contextQuery.data?.fields ?? [];
  const attachments = contextQuery.data?.attachments ?? [];

  /*
   * The decision log and the task it became.
   *
   * ⚠️ NOT READ ON A PENDING REQUEST, exactly as the RSC's ternary arranged: it
   * has no task by definition and no approval rows. `enabled` is what makes that
   * a query that never runs rather than one whose empty result is discarded.
   */
  const outcomeQuery = useQuery({
    queryKey: qk.requestPart(requestId, "outcome"),
    queryFn: () => fetchRequestOutcome(browserClient(), requestId),
    enabled: Boolean(request) && !awaitingDecision,
  });

  const decisions = outcomeQuery.data?.decisions ?? [];
  const linkedTask = outcomeQuery.data?.task ?? null;
  const nameOf = outcomeQuery.data?.names ?? {};

  /*
   * ⚠️ ERROR BEFORE PENDING, AND `notFound()` BETWEEN THEM. The order is the
   * whole of the distinction the RSC's comment was written about — see the file
   * header. A failed read must not render as "this request does not exist", and
   * a request that has not arrived yet must not render as either.
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
      <PageShell className="mx-auto w-full max-w-4xl">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={4} />
      </PageShell>
    );
  }

  /*
   * Zero rows through RLS IS a 404 — and the right thing to leak, because
   * "exists but not for you" is itself information. There is no scoped
   * `not-found.tsx` under this route, so it reaches `app/(app)/not-found.tsx`,
   * which is where it went before this file existed.
   *
   * ⚠️ `notFound()` FROM A CLIENT COMPONENT IS SUPPORTED — it throws a sentinel
   * the nearest boundary catches, exactly as the server call did. It is reached
   * only after `isPending` and `isError` are ruled out, so it can only ever mean
   * what it says.
   */
  if (!request) notFound();

  const negotiated =
    request.approved_target_date && request.approved_target_date !== request.target_date;

  const values = request.field_values ?? {};

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
          {/* P7-56. `text-info` has to come through on the wrapper — the rich
              text renderer sets no colour of its own, so the banner's tone is
              inherited.

              ⚠️ `RichTextClient`, NOT `RichText`. The server component sanitises
              as it renders and can only do so on the server; this tree is the
              browser's now, so the twin sanitises through `lib/rich-text-dom.ts`
              — same allowlist, on the side of the wire it can actually run on.
              It sanitises INTERNALLY, so callers hand it the raw column and
              never a pre-sanitised string. Importing the server one here is
              exactly the RSC boundary break `npm run build` is the only check
              for. */}
          <RichTextClient html={request.decision_reason} className="mt-1 text-info" />
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
            {/* An em dash while the form is still coming is honest — it is what
                the RSC drew for a form that could not be read, and the row above
                it has already told the reader the page is alive. */}
            <Row label="Form">{form?.name ?? "—"}</Row>
            <Row label="Description">
              <RichTextClient html={request.description} />
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

      {/*
        ⚠️ THE SUBMITTED DETAILS AND THE ATTACHMENTS SHARE ONE QUERY AND ONE
        FAILURE. Both come from `qk.requestPart(id, "context")`, so a broken read
        must not let the first card silently vanish while the second draws an
        empty file list — which is what `fields.length > 0` alone would do.
      */}
      {contextQuery.isError ? (
        <QueryError what="this request's form" message={contextQuery.error.message} />
      ) : (
        <>
          {fields.length > 0 ? (
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
                        <span className="ml-2 text-2xs text-muted-foreground">
                          (archived field)
                        </span>
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
              {/* Signed on click, not on render — a URL minted here would sit in
                  the page source and in the browser history whether or not
                  anyone opened the file. */}
              <AttachmentList attachments={attachments} />
            </CardContent>
          </Card>
        </>
      )}

      {awaitingDecision ? (
        /*
         * ⚠️ THE PANEL WAITS FOR THE FORM'S DEPARTMENT, AND IT HAS TO. Every one
         * of its four reads is keyed by `department_id`, which arrives with the
         * form — so it renders a skeleton rather than a panel with an empty PIC
         * picker and an empty capacity list, which would read as "nobody is in
         * this department" on the screen where that decides who gets the work.
         */
        form ? (
          <ReviewPanel
            requestId={request.id}
            requestTitle={request.title}
            requestDescription={request.description}
            targetDate={request.target_date}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            defaultListId={form.default_list_id}
            // P7-23. The form's department, not the viewer's: a list created
            // during the review has to belong where the task will.
            departmentId={form.department_id}
          />
        ) : contextQuery.isError ? null : (
          <CardSkeleton lines={5} />
        )
      ) : outcomeQuery.isError ? (
        <QueryError what="this request's decision" message={outcomeQuery.error.message} />
      ) : decisions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>

          {/*
            P7-63 — THE OUTCOME, READ AS AN OUTCOME.

            Three beats, in the order the story happened: what was decided, on
            what terms, and where the work went. It used to be a decision
            sentence with a <dl> bolted under it, which put the route through to
            the task in a table cell — the one thing somebody opening a closed
            request actually wants to click.
          */}
          <CardContent className="space-y-5">
            {decisions.map((decision) => (
              <div key={decision.created_at} className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {/* The chip carries a glyph as well as a label, so the
                      decision survives greyscale and a printed queue. */}
                  <ApprovalDecisionBadge decision={decision.decision} />
                  <span className="text-sm text-muted-foreground">
                    {formatDateTime(decision.created_at)}
                    {/* P7-59. `approver_id` was already being selected here and
                        never shown, so the card said what happened and not who
                        did it — the one fact somebody chasing a request needs. */}
                    {nameOf[decision.approver_id ?? ""]
                      ? ` · ${nameOf[decision.approver_id ?? ""]}`
                      : null}
                  </span>
                </div>

                {decision.reason ? (
                  // The CLIENT's words on the approval page, not staff markup —
                  // that surface has no editor. Sanitised anyway, because it is
                  // the same column shape and the sanitiser is what makes any of
                  // these safe.
                  <RichTextClient
                    html={decision.reason}
                    className="rounded-sm bg-muted/50 px-3 py-2"
                  />
                ) : null}
              </div>
            ))}

            {/*
              P7-59 / P7-63 — WHERE IT WENT.

              Only ever drawn for an approval: a returned or rejected request has
              no task and no agreed date, and stops at the reason above. The
              guard is `linkedTask` rather than the decision word, because the
              task is the thing being described.
            */}
            {linkedTask ? (
              <>
                <div>
                  <span className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Agreed delivery
                  </span>
                  <p className="mt-0.5 text-sm">
                    {formatDate(request.approved_target_date ?? request.target_date)}
                    {/* Same word the Request card above uses for the same fact, so
                        a renegotiated date reads identically in both places. */}
                    {negotiated ? (
                      <span className="ml-2 text-xs text-muted-foreground">negotiated</span>
                    ) : null}
                  </p>
                </div>

                <div>
                  <span className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                    The work
                  </span>

                  {/*
                    ONE LINK, ONE TAB STOP. A plain <Link> rather than a button
                    wearing link clothes — it navigates, so it is a link (§2.1).
                    The title, the stage and the two people are all inside it, so
                    there is no second focusable thing to tab past.

                    Raised, never inset: `grade-surface` sits BESIDE `bg-card`
                    rather than replacing it, because tailwind-merge keeps only
                    the last `bg-*` and would eat the colour token.
                  */}
                  <Link
                    href={`/tasks/${linkedTask.id}`}
                    className="mt-1.5 flex items-center gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised transition-[box-shadow,border-color] hover:border-accent-border hover:shadow-raised-lg">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-accent-border bg-accent grade-chip text-accent-foreground">
                      <ClipboardCheck aria-hidden className="size-4" />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">
                          {linkedTask.title}
                        </span>
                        <TaskStatusBadge status={linkedTask.status} />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {nameOf[linkedTask.assignee_id ?? ""] ?? "Unassigned"}
                        {nameOf[linkedTask.qa_assignee_id ?? ""]
                          ? ` · QA ${nameOf[linkedTask.qa_assignee_id ?? ""]}`
                          : null}
                      </span>
                    </span>

                    {/* Decoration only. `--foreground-faint` is 3.44:1 and may
                        never carry a word. */}
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-foreground-faint" />
                  </Link>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}

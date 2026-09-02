import Link from "next/link";
import { ArrowRight, ExternalLink, Inbox, Info } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { RequestStatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { VizservePmsRequestStatus } from "@/lib/database.types";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-66 — WHAT THE RESPONSES TAB SAYS ON A CLIENT FORM.
 *
 * ⚠️ A CLIENT FORM HAS NO ANSWER SHEET, AND BUILDING ONE WOULD BE THE MISTAKE.
 *
 * Every submission to a client form MINTS A REQUEST — a reference number the
 * client quotes back, a status, a Gate 1 decision, an SLA clock, a task once it
 * is approved. All of that already has a screen, at /requests, built around
 * exactly those things. A flat table of answers here would have nowhere to put
 * any of it, so the two screens would disagree about what a submission IS, and
 * the more convenient of the two would be the one that tells you less.
 *
 * So this shows the REQUESTS this form has minted — the same nouns /requests
 * uses, in a short read-only list — and hands off to the queue for anything
 * beyond a glance. Being told "these are requests, and here they are" is a
 * complete answer; an empty table headed "Responses" is not.
 *
 * ⚠️ THE ANSWERS TO THE FORM'S OWN QUESTIONS ARE NOT SHOWN HERE, and are not
 * lost either: they are stored on each request and rendered on the request page,
 * under the client's details, where the person reading them is already deciding
 * what to do about them.
 *
 * ⚠️ NO EXPORT BUTTON, UNLIKE THE ENGAGEMENT TAB. `exportFormResponses` reads
 * `vizserve_pms_form_responses` and refuses a client form outright — a client
 * form's rows are in the other table, and an export of requests is a different
 * file with different columns that belongs on the queue that owns them.
 */

/** How many to show before pointing at the queue. A glance, not a list. */
const RECENT_REQUESTS = 8;

export async function ClientRequestsPanel({
  formId,
  formName,
  departmentId,
  submissionCount,
}: {
  formId: string;
  formName: string;
  /** Null on an unrouted draft — see the notice below. */
  departmentId: string | null;
  /**
   * Requests this form has minted, counted by `countFormSubmissions` — which
   * reads through the SERVICE ROLE and therefore knows the true number whatever
   * the caller's own policies say. That is what lets the empty state below tell
   * "nobody has submitted" apart from "you cannot read these".
   */
  submissionCount: number;
}) {
  const supabase = await createClient();

  /*
   * No department filter. `requests readable in scope` is what decides which
   * rows come back — restating it here would imply the policy is optional
   * (CLAUDE.md). The `form_id` narrowing is not a scope filter: it says WHICH
   * form's requests this panel is about.
   */
  const { data, error } = await supabase
    .from("vizserve_pms_requests")
    .select("id, reference_no, requester_name, requester_org, status, submitted_at, target_date")
    .eq("form_id", formId)
    .order("submitted_at", { ascending: false })
    .limit(RECENT_REQUESTS);

  const requests = data ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-5">
      <section className="space-y-3.5 rounded-lg border bg-card p-5 grade-surface shadow-raised">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-[-0.014em]">
            Submissions become requests
          </h2>
          <p className="text-sm leading-relaxed text-foreground-muted">
            A client form has no answer sheet. Every submission mints a reference number and
            opens a request, which carries the status, the Gate 1 decision and the SLA clock
            that a flat table has nowhere to put.
          </p>
        </div>

        <p className="flex gap-2.5 rounded-md border border-info-border bg-info-subtle px-3 py-2.5 text-xs leading-relaxed text-info">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            The answers to your questions are stored on each request and shown on the request
            page, under the client&rsquo;s details.
          </span>
        </p>

        {/*
          ⚠️ A FAILED READ IS NOT AN EMPTY FORM. Told apart, for the reason
          `QueryError` exists everywhere else in this app: an empty screen can
          talk somebody out of reporting a fault, and "nobody has submitted this
          form" is a conclusion a lead would act on.
        */}
        {/*
          ⚠️ AN UNROUTED FORM'S REQUESTS ARE INVISIBLE TO THEIR OWN AUTHOR, and a
          failing policy returns ZERO ROWS AND NO ERROR (CLAUDE.md). `requests
          readable in scope` asks `vizserve_pms_manages_department(...)`, which is
          false for a team leader on a form with no department — a form
          `administersForm` has just confirmed is theirs to edit. So two hundred
          real requests come back as an empty list, and without this the panel
          would say "No requests yet" to the person who built the form.

          `submissionCount` is the service-role count and knows better. The
          sibling `FormResponses` carries the same notice for the same reason.
        */}
        {error ? (
          <QueryError what="this form's requests" message={error.message} />
        ) : requests.length === 0 && submissionCount > 0 ? (
          <p className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-xs leading-relaxed text-warning">
            This form has{" "}
            <span className="tabular-nums">{submissionCount}</span>{" "}
            {submissionCount === 1 ? "request" : "requests"}, and none of them is readable from
            here — the form has no department yet, so only an admin can see them. Choose one
            under Settings.
          </p>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title="No requests yet"
            description="The first client to submit this form opens a request here. It has to be published first — check Settings."
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Reference</Th>
                    <Th>Client</Th>
                    <Th>Submitted</Th>
                    <Th>Needed by</Th>
                    <Th>Status</Th>
                    <Th>
                      <span className="sr-only">Open</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr key={request.id} className="border-t">
                      <Td className="font-semibold tabular-nums">{request.reference_no}</Td>
                      <Td>
                        <span className="block truncate">{request.requester_name}</span>
                        {request.requester_org ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {request.requester_org}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {formatDateTime(request.submitted_at)}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {request.target_date ? (
                          formatDate(request.target_date)
                        ) : (
                          <span className="text-foreground-faint">
                            <span aria-hidden>—</span>
                            <span className="sr-only">No date given</span>
                          </span>
                        )}
                      </Td>
                      <Td>
                        {/* The pill carries its label, never colour alone. */}
                        <RequestStatusBadge
                          status={request.status as VizservePmsRequestStatus}
                        />
                      </Td>
                      <Td className="text-right">
                        <Link
                          href={`/requests/${request.id}`}
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                        >
                          Open
                          <ExternalLink />
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={`/requests?form=${formId}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Open all in the request queue
                <ArrowRight />
              </Link>
              {/*
                ⚠️ THE COUNT IS THE FORM'S, NOT THE TABLE'S. The list above is the
                most recent eight; saying "8 requests" over a form that has taken
                two hundred would be a number somebody quotes. It is the same
                count the tab badge shows and the same one that locks the purpose
                and the reference prefix — one count, read once.
              */}
              <p className="text-xs text-muted-foreground">
                Showing the latest{" "}
                <span className="tabular-nums">
                  {Math.min(requests.length, submissionCount)}
                </span>{" "}
                of <span className="tabular-nums">{submissionCount}</span> through {formName}.
                {/*
                  A lead CAN be short of the full list here without anything
                  failing — the same unrouted case as above, part-way: some
                  requests readable, some not. Saying so costs a clause.
                */}
                {departmentId === null
                  ? " Only an admin can read them until this form has a department."
                  : null}
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b px-2.5 py-2 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground">
      {children}
    </th>
  );
}

function Td({ className, children }: { className?: string; children: React.ReactNode }) {
  return <td className={`max-w-[16rem] px-2.5 py-2.5 align-middle ${className ?? ""}`}>{children}</td>;
}

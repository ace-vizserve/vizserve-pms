import Link from "next/link";
import { ArrowRight, Inbox, Info } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";

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
 * So the tab exists — it has to, or the strip would change shape depending on
 * what the form is for — and it says where the submissions actually went. Being
 * told "these are requests, and here is the queue" is a complete answer; an
 * empty table headed "Responses" is not.
 *
 * The answers to the form's own questions are not lost and are not shown here
 * either: they are stored on each request and rendered on the request page,
 * under the client's details, where the person reading them is already deciding
 * what to do about them.
 */
export function ClientRequestsPanel({
  formName,
  submissionCount,
}: {
  formName: string;
  /** Requests this form has minted. Counted by `countFormSubmissions`. */
  submissionCount: number;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-5">
      <section className="space-y-3 rounded-lg border bg-card p-5 grade-surface shadow-raised">
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

        {submissionCount > 0 ? (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link href="/requests" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Open the request queue
              <ArrowRight />
            </Link>
            {/*
              The number is the same one the tab badge shows and the same one
              that locks the purpose and the reference prefix — one count, read
              once, so the screen cannot say two things about how much has come
              through this form.
            */}
            <p className="text-xs text-muted-foreground">
              <span className="tabular-nums">{submissionCount}</span>{" "}
              {submissionCount === 1 ? "request has" : "requests have"} come through{" "}
              {formName}.
            </p>
          </div>
        ) : (
          <EmptyState
            icon={<Inbox />}
            title="No requests yet"
            description="The first client to submit this form opens a request here. It has to be published first — check Settings."
          />
        )}
      </section>
    </div>
  );
}

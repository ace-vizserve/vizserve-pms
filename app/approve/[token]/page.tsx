import type { Metadata } from "next";

import { Check, Clock } from "lucide-react";

import { clientTimelineSteps, type ClientTimelineStep } from "@/lib/client-timeline";
import { richTextToPlainText } from "@/lib/rich-text";
import { formatDate } from "@/lib/dates";
import { approvalPageResultSchema, type ApprovalPage } from "@/lib/schemas/client-approval";
import { createClient } from "@/utils/supabase/server";

import { ApprovalForm } from "./approval-form";
import { BrandLockup } from "@/components/brand-lockup";

export const metadata: Metadata = {
  title: "Approve your request",
  // A public URL holding a token. Keeping it out of search results is free.
  robots: { index: false, follow: false },
};

/**
 * P4-04 — the client approval page. NO SESSION, by design.
 *
 * Server-rendered, and the token never reaches client JavaScript except as the
 * URL segment it already is. The page reads through a SECURITY DEFINER function
 * that hashes the token and returns only render-safe fields — `anon` holds no
 * table privilege anywhere in this system.
 *
 * The layout follows docs/08 deliberately: what was done, then the output, then
 * THE CLIENT'S OWN ORIGINAL SPECS. That last section is what makes Amier's point
 * at 44:30 operational — the client is approving against what they asked for,
 * not re-opening the brief.
 */

async function loadPage(token: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_get_approval_page", {
    p_token: token,
  });

  if (error || !data) return null;

  const parsed = approvalPageResultSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="client-surface min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5">
          <BrandLockup align="stacked" subtitle="Request approval" />
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * P16-09 — how it got here. Below the work and the output, because the client
 * is here to check the work; this is context for it, not the point of it.
 *
 * The last row is theirs and is always drawn: it is the one step still open.
 * Done and waiting are told apart by icon AND by words ("Waiting on you"),
 * never by colour alone.
 */
function Timeline({ steps, deadline }: { steps: ClientTimelineStep[]; deadline: string }) {
  if (steps.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Progress
      </h2>
      <ol className="mt-3 space-y-0">
        {steps.map((step) => (
          <li key={step.key} className="relative flex gap-3 pb-4">
            <span
              aria-hidden
              className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border"
            />
            <span className="relative mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 text-sm sm:flex sm:items-baseline sm:justify-between sm:gap-3">
              <p>
                <span className="font-medium">{step.label}</span>
                {step.person ? (
                  <span className="text-muted-foreground"> · {step.person}</span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground sm:shrink-0">{step.date}</p>
            </div>
          </li>
        ))}
        <li className="flex gap-3">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-card text-primary">
            <Clock className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 text-sm sm:flex sm:items-baseline sm:justify-between sm:gap-3">
            <p>
              <span className="font-medium">Your approval</span>
              <span className="text-muted-foreground"> · Waiting on you</span>
            </p>
            {deadline !== "—" ? (
              <p className="text-xs text-muted-foreground sm:shrink-0">by {deadline}</p>
            ) : null}
          </div>
        </li>
      </ol>
    </section>
  );
}

function Message({ heading, body }: { heading: string; body: string }) {
  return (
    <Shell>
      <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-8 text-center">
        <h1 className="text-lg font-semibold">{heading}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
    </Shell>
  );
}

export default async function ClientApprovalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await loadPage(token);

  // One shape of answer for a bad token and a missing one. Distinguishing them
  // would tell someone probing which guesses were close.
  if (!result || result.ok === false) {
    const error = result && result.ok === false ? result.error : "invalid";

    return error === "expired" ? (
      <Message
        heading="This link has expired"
        body="Approval links are valid for a limited time. Reply to the email we sent you and we will issue a new one."
      />
    ) : (
      <Message
        heading="This link is not valid"
        body="Check that you used the most recent email we sent you. If you are still stuck, reply to it and we will help."
      />
    );
  }

  const page: ApprovalPage = result;

  if (page.consumed) {
    return (
      <Message
        heading="Thank you — this has been answered"
        body="We have your response and the team has been told. There is nothing more you need to do."
      />
    );
  }

  if (page.status !== "FOR_CLIENT_APPROVAL") {
    return (
      <Message
        heading="This is no longer waiting on you"
        body="It has already moved on. If that is unexpected, reply to the email we sent you."
      />
    );
  }

  const values = page.field_values as Record<string, unknown>;
  const answered = page.fields.filter((field) => {
    const value = values[field.field_key];
    return value !== null && value !== undefined && value !== "";
  });

  return (
    <Shell>
      <div className="space-y-4">
        <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-6 sm:p-8">
          <p className="text-xs text-muted-foreground">
            {page.reference_no}
            {/* P16-06 — a chain of approvers says where this one sits. */}
            {page.steps > 1 ? ` · approver ${page.step} of ${page.steps}` : null}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{page.title}</h1>

          <dl className="mt-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-3 border-b py-2 sm:border-0">
              <dt className="text-muted-foreground">You requested</dt>
              <dd>{formatDate(page.submitted_at?.slice(0, 10) ?? null)}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b py-2 sm:border-0">
              <dt className="text-muted-foreground">Agreed delivery</dt>
              <dd>{formatDate(page.agreed_date)}</dd>
            </div>
          </dl>

          {page.resolution ? (
            <section className="mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What was done
              </h2>
              {/*
                ⚠️ FLATTENED, NOT RENDERED AS MARKUP — decision 3 of P7-56.
                This is an unauthenticated client-facing page, and the QA
                resolution it shows is the one rich-text column a person outside
                the company ever reads. Flattening keeps the client's view of it
                identical to the email they were sent, and keeps this page's
                blast radius at zero: there is no `dangerouslySetInnerHTML` on
                any surface a stranger can reach.
              */}
              <p className="mt-2 whitespace-pre-wrap text-sm">
                {richTextToPlainText(page.resolution)}
              </p>
            </section>
          ) : null}

          {page.output_link || page.attachments.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Output
              </h2>
              <ul className="mt-2 space-y-1 text-sm">
                {page.output_link ? (
                  <li>
                    <a
                      href={page.output_link}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-primary underline underline-offset-4"
                    >
                      {page.output_link}
                    </a>
                  </li>
                ) : null}
                {page.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <a
                      href={`/approve/${token}/file/${attachment.id}`}
                      className="text-primary underline underline-offset-4"
                    >
                      {attachment.filename}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Timeline
            steps={clientTimelineSteps(page.timeline)}
            deadline={formatDate(page.auto_complete_at?.slice(0, 10) ?? null)}
          />

          {/* Collapsed, and below the output — the client is checking the work
              against their brief, not rewriting the brief (Amier 44:30). */}
          {answered.length > 0 ? (
            <details className="mt-6 rounded-md border px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Your original specs
              </summary>
              <dl className="mt-3 text-sm">
                {answered.map((field) => {
                  const raw = values[field.field_key];
                  return (
                    <div
                      key={field.field_key}
                      className="grid gap-1 border-b py-2 last:border-0 sm:grid-cols-[10rem_1fr] sm:gap-3"
                    >
                      <dt className="text-xs text-muted-foreground">{field.label}</dt>
                      <dd className="min-w-0 wrap-break-word">
                        {Array.isArray(raw) ? raw.join(", ") : String(raw)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          ) : null}
        </div>

        <ApprovalForm
          token={token}
          requesterName={page.approver_name ?? page.requester_name ?? ""}
          deadline={formatDate(page.auto_complete_at?.slice(0, 10) ?? null)}
        />
      </div>
    </Shell>
  );
}

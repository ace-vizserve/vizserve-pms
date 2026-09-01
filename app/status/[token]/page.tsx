import type { Metadata } from "next";
import { Check, Dot, PackageSearch } from "lucide-react";

import { BrandLockup } from "@/components/brand-lockup";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { RequestStatusResult } from "@/lib/request-status";
import { createClient } from "@/utils/supabase/server";
import { cn } from "@/lib/utils";

/**
 * P7-51 — "track your request", the page the acknowledgement links to.
 *
 * PUBLIC AND UNAUTHENTICATED, by design and like `/request/[slug]` and
 * `/feedback/[token]`. The client has no account and never will; the token in
 * the URL is the whole credential.
 *
 * `noindex` because these URLs end up in inboxes, and an inbox is a place
 * crawlers reach more often than anybody expects. A tracking page that turned
 * up in a search result would be a data leak with a token attached.
 */
export const metadata: Metadata = {
  title: "Track your request",
  robots: { index: false, follow: false },
};

/**
 * Never cached. The point of the page is that it is current — a client
 * refreshing after a phone call must not be served the version from before it.
 */
export const dynamic = "force-dynamic";

/**
 * THE SAME SHELL `/approve/[token]` USES, down to the class list.
 *
 * These are the two pages a client ever sees after the form, often in the same
 * week and from the same thread of emails. They had drifted: this one drew its
 * own "VIZSERVE" in letter-spaced caps and a `shadow-sm` card, while the
 * approval page used `BrandLockup` and `shadow-raised-lg`. A client who
 * approves work on Tuesday and tracks the next request on Thursday should not
 * be looking at two different companies — and a hand-set wordmark instead of
 * the real asset is precisely the detail that makes a page read as phishing
 * (§4.6).
 *
 * `client-surface` is what grows every control to a 44px target.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="client-surface min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5">
          <BrandLockup align="stacked" />
        </div>
        {children}
      </div>
    </main>
  );
}

export default async function RequestStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_get_request_status", {
    p_token: token,
  });

  const result = (error ? { ok: false, error: "invalid" } : data) as RequestStatusResult;

  /*
   * ONE MESSAGE FOR EVERY FAILURE, matching the function underneath.
   *
   * A transport error and an unknown token are rendered identically on purpose.
   * Telling somebody "that token does not exist" versus "something went wrong"
   * is exactly the signal that makes guessing worthwhile, and this page is
   * reachable by anyone with a URL bar.
   */
  if (!result?.ok) {
    return (
      <Shell>
        <div className="rounded-lg border bg-card grade-surface p-8 text-center shadow-raised-lg">
          <PackageSearch className="mx-auto size-6 text-muted-foreground" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold">This tracking link is not valid</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            The link may have been mistyped or truncated by an email client. Open it directly from
            the email we sent you, or reply to that email and we will send a fresh one.
          </p>
        </div>
      </Shell>
    );
  }

  const timeline = result.timeline ?? [];
  const latest = timeline[timeline.length - 1];

  /**
   * ⚠️ NEWEST FIRST. The trace used to run oldest-to-newest, so the answer to
   * the only question this page exists to answer — where is my request now —
   * was at the BOTTOM, under everything that had already happened. That is the
   * right order for a courier's scan history, which people read to reconstruct
   * a journey, and the wrong one here: a client opens this link from an email
   * to check one thing, and on a phone the current step was below the fold on
   * a request with any history at all.
   *
   * The source stays chronological — `vizserve_pms_get_request_status` returns
   * it that way and `latest` is still its last row. Only the reading order is
   * reversed, and the dates are on every entry, so nothing is ambiguous.
   */
  const entries = [...timeline].reverse();

  // The agreed date where Gate 1 set one, otherwise what was asked for. Which
  // of the two is being shown is stated in the label rather than left implied.
  const agreed = result.approved_target_date;
  const requested = result.target_date;

  return (
    <Shell>
      <h1 className="mb-5 text-center text-2xl font-semibold tracking-tight">Track your request</h1>

      <section className="rounded-lg border bg-card grade-surface shadow-raised-lg">
        {/* The summary band. Reference first and largest: it is the string the
            client quotes back to us and the one they came here holding. */}
        <div className="grid gap-4 border-b p-5 sm:grid-cols-3 sm:items-center">
          <div>
            <p className="text-2xs tracking-wide text-muted-foreground uppercase">Reference</p>
            <p className="mt-0.5 font-semibold tabular-nums">{result.reference_no}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-2xs tracking-wide text-muted-foreground uppercase">Request</p>
            <p className="mt-0.5 font-medium">{result.title}</p>
          </div>
        </div>

        <div className="grid gap-4 border-b p-5 sm:grid-cols-3">
          <div>
            <p className="text-2xs tracking-wide text-muted-foreground uppercase">Submitted</p>
            <p className="mt-0.5 text-sm">{formatDate(result.submitted_at)}</p>
          </div>
          <div>
            <p className="text-2xs tracking-wide text-muted-foreground uppercase">
              {agreed ? "Agreed delivery" : "Date requested"}
            </p>
            <p className="mt-0.5 text-sm">
              {agreed ? (
                formatDate(agreed)
              ) : requested ? (
                formatDate(requested)
              ) : (
                <span className="text-muted-foreground">Not specified</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-2xs tracking-wide text-muted-foreground uppercase">Latest update</p>
            <p className="mt-0.5 text-sm font-medium">{latest?.label ?? "Received"}</p>
          </div>
        </div>

        {/*
          THE TRACE, NEWEST FIRST — and it says so, because a reversed list that
          does not announce itself is a list somebody reads forwards and
          misunderstands. Every entry carries its own date and time as the
          second carrier, so the order is never the only thing establishing
          sequence.
        */}
        <div className="flex items-baseline justify-between gap-3 border-b px-5 py-3">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Progress
          </h2>
          <p className="text-2xs text-muted-foreground">Newest first</p>
        </div>

        <ol className="p-5">
          {entries.map((entry, index) => {
            // Index 0 is the CURRENT step now, and the bottom of the list is
            // where the request started.
            const isLatest = index === 0;
            const isOldest = index === entries.length - 1;

            return (
              <li key={`${entry.at}-${entry.label}`} className="flex gap-4">
                {/* The rail: a marker and the line beneath it. The line is
                    omitted on the OLDEST entry — the bottom of the list — so
                    the trace ends rather than trailing into nothing. */}
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      isLatest
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}>
                    {isLatest ? (
                      <Dot className="size-5" aria-hidden />
                    ) : (
                      <Check className="size-3.5" aria-hidden />
                    )}
                  </span>
                  {!isOldest ? <span aria-hidden className="mt-1 w-px flex-1 bg-border" /> : null}
                </div>

                <div className={cn("min-w-0 flex-1", isOldest ? "pb-0" : "pb-6")}>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(entry.at)}
                  </p>
                  {/* The label carries the state, never the marker's colour
                      alone — this page is read on phones, printed, and
                      forwarded, and the tint survives none of those reliably.
                      "Happening now" is a WORD on the current step for the same
                      reason. */}
                  <p
                    className={cn(
                      "mt-0.5 flex flex-wrap items-center gap-2 text-sm font-semibold",
                      isLatest && "text-primary",
                    )}>
                    {entry.label}
                    {isLatest ? (
                      <span className="rounded-sm border border-accent-border bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-foreground">
                        Happening now
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {entry.detail}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
        This page updates as your request moves. Bookmark it, or open it again from the email we
        sent you. Quote {result.reference_no} if you need to ask us anything.
      </p>
    </Shell>
  );
}

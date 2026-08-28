import type { Metadata } from "next";
import { Check, CircleDashed, PackageSearch } from "lucide-react";

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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">{children}</div>
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
        <div className="rounded-lg border bg-card p-8 text-center shadow-sm">
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
  // Most recent LAST, and the newest entry is the one that gets the filled
  // marker — the same reading order LBC uses, and the one a person scanning for
  // "where is it now" expects at the bottom.
  const latest = timeline[timeline.length - 1];

  // The agreed date where Gate 1 set one, otherwise what was asked for. Which
  // of the two is being shown is stated in the label rather than left implied.
  const agreed = result.approved_target_date;
  const requested = result.target_date;

  return (
    <Shell>
      <header className="mb-6 text-center">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          VizServe
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Track your request</h1>
      </header>

      <section className="rounded-lg border bg-card shadow-sm">
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

        {/* The trace. */}
        <ol className="p-5">
          {timeline.map((entry, index) => {
            const isLatest = index === timeline.length - 1;

            return (
              <li key={`${entry.at}-${entry.label}`} className="flex gap-4">
                {/* The rail: a marker and the line beneath it. The line is
                    omitted on the last entry so the trace ends rather than
                    trailing into nothing. */}
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      isLatest ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {isLatest ? (
                      <CircleDashed className="size-3.5" aria-hidden />
                    ) : (
                      <Check className="size-3.5" aria-hidden />
                    )}
                  </span>
                  {index < timeline.length - 1 ? (
                    <span aria-hidden className="mt-1 w-px flex-1 bg-border" />
                  ) : null}
                </div>

                <div className={cn("pb-6", isLatest && "pb-0")}>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(entry.at)}
                  </p>
                  {/* The label carries the state, never the marker's colour
                      alone — this page is read on phones, printed, and
                      forwarded, and the tint survives none of those reliably. */}
                  <p className={cn("mt-0.5 text-sm font-semibold", isLatest && "text-primary")}>
                    {entry.label}
                    {isLatest ? <span className="sr-only"> — most recent</span> : null}
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

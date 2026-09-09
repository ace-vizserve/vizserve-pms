"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

/**
 * P12-05 — the error boundary for the authenticated app. There was none.
 *
 * ⚠️ UNTIL THIS FILE, `app/` CONTAINED NO `error.tsx` ANYWHERE, and the absence
 * shaped the whole codebase. The P12-01 sweep found 353 `?? []` / `?? 0` sites
 * and could not use the cheapest correct fix for any of them — "check the error
 * and let it throw" needs somewhere to land, and there was nowhere. So every
 * fix had to be a returned state or a logged degrade, one page at a time. This
 * is the missing half.
 *
 * It renders INSIDE the shell, exactly as `not-found.tsx` beside it does and for
 * the same reason: the nav stays, the breadcrumb stays, and the failure is
 * confined to the middle of the page where it happened. Losing the entire
 * application frame because one query threw is a bigger event than what
 * actually occurred, and it strands somebody with no way out but the back
 * button.
 *
 * ⚠️ IT CANNOT CATCH `app/(app)/layout.tsx`. A boundary does not catch errors
 * thrown by the layout it is rendered inside — `requireAuthContext()`, the
 * temporary-password wall and the `app_access` gate all live there, so their
 * failures bubble past this to `app/error.tsx`. That is correct: a broken auth
 * gate must NOT render inside the shell it failed to authorise.
 *
 * ⚠️ THE MESSAGE IS SHOWN, NOT HIDDEN, and that is a settled position in this
 * repo rather than a lapse. `components/query-error.tsx` argues it: this is an
 * internal tool for sixteen colleagues, and `permission denied for table …` or
 * `canceling statement due to statement timeout` tells whoever reads it far more
 * than "something went wrong". `readableError` takes the same line on the write
 * path. In PRODUCTION Next redacts the message itself and supplies `digest`
 * instead, which is why both are rendered — the digest is the only handle on a
 * server error once the text is gone, and a person who cannot quote it cannot
 * be helped.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /*
   * ⚠️ LOGGED HERE BECAUSE NOTHING ELSE LOGS IT. React hands the error to this
   * component and considers the matter closed; a boundary that renders a
   * sentence and drops the stack is how a fault becomes unreproducible. This is
   * the same rule the sweep applied everywhere else — a failure nobody can see
   * is worse than a failure.
   *
   * The dev server prints server-side throws already; this covers the client
   * half, and puts both in the same place a person is told to look.
   */
  useEffect(() => {
    console.error("[app] unhandled error", error);
  }, [error]);

  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      {/*
        `role="alert"`, unlike `not-found.tsx`. A 404 is a destination; this
        appeared because something broke while somebody was working, which is
        worth interrupting a screen reader for. Same call `QueryError` makes.
      */}
      <div role="alert">
        <EmptyState
          icon={<TriangleAlert />}
          title="Something went wrong on this page"
          description="This is a fault, not an empty screen — nothing is missing because you have no records. Try again, and if it keeps happening give whoever is on support the detail below."
          action={
            <div className="flex flex-col items-center gap-3">
              {/*
                `reset()` re-renders the segment. It is the right first move for
                the failure this app actually has — a timed-out or dropped query
                usually succeeds on a second attempt — and it costs nothing when
                the fault is permanent.
              */}
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCw />
                Try again
              </Button>

              {/*
                The message in development, the digest in production. Never both
                absent: a failure the reader cannot quote is a failure nobody can
                act on. `break-all` because a PostgREST message is one long line
                and would otherwise push the layout sideways.
              */}
              {error.message ? (
                <code className="max-w-md overflow-x-auto rounded bg-muted px-2 py-1 text-2xs break-all text-foreground">
                  {error.message}
                </code>
              ) : null}

              {error.digest ? (
                <p className="text-2xs text-muted-foreground">
                  Reference <code className="font-mono">{error.digest}</code>
                </p>
              ) : null}
            </div>
          }
        />
      </div>
    </PageShell>
  );
}

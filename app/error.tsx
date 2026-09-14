"use client";

import { useEffect } from "react";

/**
 * P12-05 — the root error boundary. What catches the things the app shell
 * cannot.
 *
 * ⚠️ THIS IS NOT A DUPLICATE OF `app/(app)/error.tsx`. A boundary never catches
 * the layout it renders inside, so everything thrown by
 * `app/(app)/layout.tsx` — `requireAuthContext()`, the temporary-password wall,
 * the `app_access` gate, the deactivation check — bubbles past that one and
 * lands here. Which is exactly right: a failed authorisation gate must not
 * render inside the shell it failed to authorise, complete with a working nav.
 *
 * It also covers everything OUTSIDE the authenticated area, and that is the half
 * that needs the most care:
 *
 *   `app/request/[slug]`   the public client form — no session, by design
 *   `app/approve/[token]`  Gate 3, a client with no login
 *   `app/status/[token]`   a client checking on their own request
 *   `app/feedback/[token]` the same
 *   `app/login`            somebody who is not signed in yet
 *
 * ⚠️ SO THE COPY IS WRITTEN FOR A CLIENT, NOT A COLLEAGUE, and the difference is
 * the whole design of this file. `app/(app)/error.tsx` prints the Postgres
 * sentence because sixteen colleagues benefit from reading it — the position
 * `components/query-error.tsx` argues at length. A CLIENT OF VIZSERVE MUST NOT
 * SEE THAT. `permission denied for table vizserve_pms_requests` names internal
 * tables and internal structure to somebody outside the company, and it tells
 * them nothing they can act on. Only the digest is shown here: it is opaque,
 * it is quotable, and it is the handle support needs.
 *
 * ⚠️ NO SHELL, NO IMPORTS FROM `components/app-shell`, AND NO LINK TO `/`.
 * The reader may have no session at all. `PageShell` and `EmptyState` are safe
 * (pure presentation), but this deliberately uses neither: this file must render
 * when almost anything else is broken, so it depends on nothing but React and
 * Tailwind tokens. A boundary with a dependency graph is a boundary that can
 * fail on the way to reporting a failure.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The full error, in the console, always — including the message this page
    // deliberately does not render. A developer on the machine can read it; the
    // client looking at the page cannot.
    console.error("[root] unhandled error", error);
  }, [error]);

  return (
    <main
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center"
    >
      <h1 className="font-heading text-lg font-semibold tracking-[-0.014em] text-foreground">
        Something went wrong
      </h1>

      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        This page could not be loaded. It is a fault on our side, not something you did. Please try
        again in a moment.
      </p>

      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Try again
      </button>

      {/*
        The digest and nothing else. Opaque by construction, so it names no
        table and leaks no structure — and it is the only thing that connects
        what a client saw to what the server logged.
      */}
      {error.digest ? (
        <p className="text-2xs text-muted-foreground">
          Reference <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
    </main>
  );
}

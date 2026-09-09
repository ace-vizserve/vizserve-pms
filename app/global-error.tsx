"use client";

import { useEffect } from "react";

/**
 * P12-05 — the last resort. What catches a failure in the ROOT LAYOUT itself.
 *
 * ⚠️ IT REPLACES `app/layout.tsx` ENTIRELY, WHICH IS WHY IT RENDERS ITS OWN
 * `<html>` AND `<body>`. Next mounts this in place of the root layout, so
 * nothing that layout normally provides exists here: no `<ThemeProvider>`, no
 * font variables, no `globals.css` class names guaranteed to mean anything —
 * the stylesheet may itself be what failed.
 *
 * ⚠️ SO THE STYLING IS INLINE, ON PURPOSE. Tailwind tokens like `bg-background`
 * resolve through `app/globals.css`, and a boundary that needs the stylesheet in
 * order to report that the stylesheet is broken reports nothing at all. Plain
 * inline styles and a system font stack always render. This is the one file in
 * the repo where that is the right call, and it should not be "tidied" to match
 * the others.
 *
 * ⚠️ IT IS NOT A COPY OF `app/error.tsx`. That one catches everything below the
 * root layout — including the whole authenticated shell and the public token
 * pages. This one only fires when the root layout or its providers throw, which
 * in practice means a build or configuration fault rather than a data one. In
 * development Next shows its own overlay instead, so this is close to
 * production-only and will almost never be seen. That is the point of a floor.
 *
 * The digest and nothing else, for the same reason as `app/error.tsx`: the
 * reader may be a client of VizServe rather than a colleague, and an internal
 * Postgres sentence names internal structure to somebody outside the company.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global] root layout failed", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#ffffff",
          color: "#1a1a1a",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>Something went wrong</h1>

        <p style={{ maxWidth: "28rem", fontSize: "0.875rem", lineHeight: 1.6, margin: 0 }}>
          VizServe Team Portal could not start. Please try again in a moment.
        </p>

        <button
          type="button"
          onClick={reset}
          style={{
            borderRadius: "0.375rem",
            border: "1px solid #d4d4d8",
            background: "#ffffff",
            padding: "0.375rem 0.75rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Try again
        </button>

        {error.digest ? (
          <p style={{ fontSize: "0.75rem", color: "#71717a", margin: 0 }}>
            Reference <code>{error.digest}</code>
          </p>
        ) : null}
      </body>
    </html>
  );
}

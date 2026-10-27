/**
 * P17-05 — send a browser error to the error log.
 *
 * Called from the error pages. Fire-and-forget, and it can never throw: it
 * runs on a page that is already showing an error.
 *
 * ⚠️ AN ERROR WITH A DIGEST IS SKIPPED. A digest means React carried it from
 * the server, where `instrumentation.ts` has already recorded it with more
 * detail than the browser ever gets — sending it again would count every
 * server error twice.
 */
export function reportClientError(error: Error & { digest?: string }, boundary: string): void {
  if (error.digest) return;
  try {
    void fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Outlives the page if the person navigates away straight after.
      keepalive: true,
      body: JSON.stringify({
        message: error.message || error.name || "Unknown error",
        stack: error.stack ?? null,
        path: window.location.pathname,
        boundary,
      }),
    }).catch(() => {});
  } catch {
    // Nothing to do: reporting must never become the second error.
  }
}

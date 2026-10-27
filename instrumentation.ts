import type { Instrumentation } from "next";

/**
 * P17-05 — every server error, into the error log (/admin/errors).
 *
 * Next calls this for a failed page render, server action, route handler or
 * proxy run. Node only: the reporter uses the service-role client, and the
 * import is dynamic so nothing server-side is bundled for the edge runtime.
 *
 * Awaited, as the docs require — on a serverless function an un-awaited write
 * can be frozen mid-flight when the response ends. `recordError` never throws.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { describeThrown, isExpectedError } = await import("@/lib/error-log");
  if (isExpectedError(error)) return;

  const { recordError, userIdFromCookieHeader } = await import("@/lib/error-log-server");
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value.join("; ") : value;
  };
  const thrown = describeThrown(error);

  await recordError({
    source: "server",
    kind: context.routeType,
    method: request.method,
    path: request.path,
    route: context.routePath,
    message: thrown.message,
    digest: thrown.digest,
    stack: thrown.stack,
    user_id: await userIdFromCookieHeader(header("cookie")),
    user_agent: header("user-agent") ?? null,
  });
};

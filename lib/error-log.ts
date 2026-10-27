import { addDays, toAppDateString } from "@/lib/dates";

/**
 * P17-05 — the error log's rules, kept apart from the code that writes and the
 * screen that reads so both can be tested without a database or a browser.
 *
 * Client-safe: no `server-only`, no Supabase. `lib/error-log-server.ts` does
 * the writing.
 */

export const ERROR_SOURCES = ["server", "client"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const ERROR_ENVIRONMENTS = ["production", "preview", "development"] as const;
export type ErrorEnvironment = (typeof ERROR_ENVIRONMENTS)[number];

/** Next's `routeType`, plus `client`. What the person was doing when it broke. */
export const ERROR_KIND_LABELS: Record<string, string> = {
  render: "Opening a page",
  action: "Saving",
  route: "API call",
  proxy: "Sign-in check",
  client: "In the browser",
};

export function errorKindLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind] ?? kind;
}

export const ENVIRONMENT_LABELS: Record<ErrorEnvironment, string> = {
  production: "Live",
  preview: "Staging",
  development: "Local",
};

/**
 * Which deployment this is. Vercel sets `VERCEL_ENV` on production and on
 * every preview — `staging` is a preview — and nothing sets it on a laptop.
 */
export function currentEnvironment(env: Record<string, string | undefined> = process.env): ErrorEnvironment {
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview") return "preview";
  return "development";
}

/**
 * ⚠️ LOCAL DEV IS NOT RECORDED unless asked for. It points at the live
 * project, and `next dev` raises errors a deployed build never would — the
 * prerender warnings alone are several a minute — so recording them would bury
 * the real ones. `ERROR_LOG_DEV=1` turns it on for testing this screen.
 */
export function shouldRecord(env: Record<string, string | undefined> = process.env): boolean {
  return currentEnvironment(env) !== "development" || env.ERROR_LOG_DEV === "1";
}

/**
 * Control flow, not failure. `redirect()` and `notFound()` throw by design,
 * and `ForbiddenError` is the authorization layer refusing somebody on purpose
 * — the screen they land on already explains it. None of these is a bug.
 */
const EXPECTED_DIGESTS = ["NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK", "NEXT_NOT_FOUND", "DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING"];
const EXPECTED_NAMES = ["ForbiddenError", "AbortError"];

export function isExpectedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const digest = "digest" in error ? String((error as { digest?: unknown }).digest ?? "") : "";
  if (EXPECTED_DIGESTS.some((prefix) => digest.startsWith(prefix))) return true;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return EXPECTED_NAMES.includes(name);
}

export const LIMITS = { message: 2000, stack: 8000, path: 500, route: 300, userAgent: 300 } as const;

function clip(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * The path without its query or hash. A query here can carry a client's
 * approval token or a search somebody typed; the path alone is enough to find
 * the bug.
 */
export function stripQuery(path: string | null | undefined): string | null {
  if (!path) return null;
  return clip(path.split(/[?#]/)[0], LIMITS.path);
}

export type ErrorReport = {
  source: ErrorSource;
  kind: string;
  environment: ErrorEnvironment;
  method?: string | null;
  path?: string | null;
  route?: string | null;
  message: string;
  digest?: string | null;
  stack?: string | null;
  user_id?: string | null;
  user_agent?: string | null;
};

/** Fit a report to the table's constraints, so a long stack is cut, not refused. */
export function toErrorRow(report: ErrorReport) {
  return {
    source: report.source,
    kind: clip(report.kind, 20) ?? "unknown",
    environment: report.environment,
    method: clip(report.method, 10),
    path: stripQuery(report.path),
    route: clip(report.route, LIMITS.route),
    message: clip(report.message, LIMITS.message) ?? "Unknown error",
    digest: clip(report.digest, 100),
    stack: clip(report.stack, LIMITS.stack),
    user_id: report.user_id ?? null,
    user_agent: clip(report.user_agent, LIMITS.userAgent),
  };
}

/** The message and stack of anything thrown — an `Error` or not. */
export function describeThrown(error: unknown): { message: string; stack: string | null; digest: string | null } {
  if (error instanceof Error) {
    const digest = "digest" in error ? String((error as { digest?: unknown }).digest ?? "") || null : null;
    return { message: error.message || error.name || "Unknown error", stack: error.stack ?? null, digest };
  }
  return { message: typeof error === "string" ? error : JSON.stringify(error) ?? "Unknown error", stack: null, digest: null };
}

export const ERROR_PERIODS = ["1", "7", "30"] as const;
export type ErrorPeriod = (typeof ERROR_PERIODS)[number];

export function isErrorPeriod(value: unknown): value is ErrorPeriod {
  return typeof value === "string" && (ERROR_PERIODS as readonly string[]).includes(value);
}

/**
 * Errors per Manila day, oldest first, with the empty days present — a gap in
 * an error chart is the good news, and dropping it would draw a quiet week as
 * a short one.
 */
export function dailyCounts(timestamps: string[], days: number, today: string): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const stamp of timestamps) {
    const day = toAppDateString(new Date(stamp));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const out: { day: string; count: number }[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = addDays(today, -back);
    if (day) out.push({ day, count: counts.get(day) ?? 0 });
  }
  return out;
}

/**
 * The same bug, counted once. Keyed on the route file and the first line of
 * the message, so `/tasks/[id]` failing for twenty different tasks is one row
 * with a count of twenty, not twenty rows.
 */
export function topErrors(
  rows: { message: string; route: string | null; path: string | null; occurred_at: string }[],
  limit = 5,
): { message: string; where: string; count: number; last: string }[] {
  const groups = new Map<string, { message: string; where: string; count: number; last: string }>();
  for (const row of rows) {
    const message = row.message.split("\n")[0];
    const where = row.route ?? row.path ?? "—";
    const key = `${where}\u0000${message}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (row.occurred_at > group.last) group.last = row.occurred_at;
    } else {
      groups.set(key, { message, where, count: 1, last: row.occurred_at });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, limit);
}

/**
 * Errors per hour over the last 24, oldest first, for the one-day view — a
 * single daily bar would say nothing about when in the day things broke.
 * Each bucket is labelled with its starting hour in Manila.
 */
export function hourlyCounts(timestamps: string[], now: number): { label: string; count: number }[] {
  const HOUR = 60 * 60 * 1000;
  // CLOCK hours, not rolling 60-minute windows, because the bars are labelled
  // "10 AM": 09:59 and 10:10 are two bars. Manila is a whole-hour offset from
  // UTC, so a UTC hour boundary is a Manila one.
  const currentHour = Math.floor(now / HOUR);
  const counts = new Array<number>(24).fill(0);
  for (const stamp of timestamps) {
    const back = currentHour - Math.floor(new Date(stamp).getTime() / HOUR);
    if (back >= 0 && back < 24) counts[23 - back] += 1;
  }
  const hour = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "numeric", hour12: true });
  return counts.map((count, index) => ({ label: hour.format(new Date(now - (23 - index) * HOUR)), count }));
}

/**
 * The window a period covers, read from the clock. A function rather than a
 * `Date.now()` in the page, which React's purity rule refuses in a render.
 */
export function errorWindow(period: ErrorPeriod): { now: number; since: string } {
  const now = Date.now();
  return { now, since: new Date(now - Number(period) * 24 * 60 * 60 * 1000).toISOString() };
}

/**
 * What the screen opens on. HERE, not in `error-filters.tsx`: that file is
 * "use client", and a server page importing a value from a client module gets
 * a reference stub, not the value — `Number(DEFAULT_PERIOD)` was NaN and the
 * page threw "Invalid time value".
 */
export const DEFAULT_PERIOD: ErrorPeriod = "7";
export const DEFAULT_ENVIRONMENT: ErrorEnvironment = "production";

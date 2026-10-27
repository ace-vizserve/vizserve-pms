import type { Metadata } from "next";
import Link from "next/link";
import { Bug, DatabaseZap, SearchX } from "lucide-react";

import { requireAdmin } from "@/lib/auth/authorization";
import { formatDate, formatDateTime, todayInAppZone } from "@/lib/dates";
import {
  dailyCounts,
  DEFAULT_ENVIRONMENT,
  DEFAULT_PERIOD,
  ENVIRONMENT_LABELS,
  ERROR_ENVIRONMENTS,
  errorKindLabel,
  errorWindow,
  hourlyCounts,
  isErrorPeriod,
  topErrors,
  type ErrorEnvironment,
  type ErrorPeriod,
} from "@/lib/error-log";
import { ilikeAnyOf } from "@/lib/search";
import { createClient } from "@/utils/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { ListSearch } from "@/components/list-search";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";

import { ErrorFilters } from "./error-filters";
import { ErrorsChart, TopErrors } from "./errors-chart";
import { ErrorsTable, type ErrorEntry } from "./errors-table";

export const metadata: Metadata = { title: "Error log" };

/** How many rows the chart and the "most frequent" list read. A month of a bad day is well under it. */
const SUMMARY_CAP = 5000;

/**
 * P17-05 — the error log. What failed, beside the audit trail's record of what
 * succeeded.
 *
 * ADMIN (IT) ONLY, enforced twice: `requireAdmin()` here, and the policy under
 * the query, which compares the acting role by equality. The nav row is the
 * third, and protects nobody. Read through the ordinary session client, like the
 * audit trail, so the screen can never show more than the policy allows.
 *
 * OPENS ON LIVE, LAST 7 DAYS. Staging and local share this database; an
 * operator glancing at this screen is asking whether production is healthy.
 */
export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; size?: string; period?: string; env?: string; source?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const supabase = await createClient();

  const term = params.q?.trim() ?? "";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);
  const period: ErrorPeriod = isErrorPeriod(params.period) ? params.period : DEFAULT_PERIOD;
  // `env=all` is the explicit "everywhere"; no key is the default, Live.
  const environment: ErrorEnvironment | null =
    params.env === "all"
      ? null
      : (ERROR_ENVIRONMENTS as readonly string[]).includes(params.env ?? "")
        ? (params.env as ErrorEnvironment)
        : DEFAULT_ENVIRONMENT;
  const source = params.source === "server" || params.source === "client" ? params.source : null;

  const { now, since } = errorWindow(period);

  // One filter builder for both reads, so the chart and the table can never be
  // counting different things.
  const filtered = <T extends { gte: (c: string, v: string) => T; eq: (c: string, v: string) => T; or: (f: string) => T }>(
    query: T,
  ): T => {
    let next = query.gte("occurred_at", since);
    if (environment) next = next.eq("environment", environment);
    if (source) next = next.eq("source", source);
    if (term) {
      const search = ilikeAnyOf(["message", "path", "route"], term);
      if (search) next = next.or(search);
    }
    return next;
  };

  const from = (page - 1) * pageSize;
  const [list, summary, people] = await Promise.all([
    filtered(
      supabase
        .from("vizserve_pms_error_logs")
        .select("id, occurred_at, source, kind, environment, method, path, route, message, digest, stack, user_id, user_agent", {
          count: "exact",
        }),
    )
      .order("occurred_at", { ascending: false })
      .range(from, from + pageSize - 1),
    filtered(supabase.from("vizserve_pms_error_logs").select("occurred_at, message, route, path"))
      .order("occurred_at", { ascending: false })
      .limit(SUMMARY_CAP),
    supabase.from("vizserve_pms_users").select("id, full_name"),
  ]);

  // Before the migration is pasted: say so, rather than a Postgres sentence.
  const missing = list.error && /does not exist|PGRST205|schema cache/i.test(`${list.error.code} ${list.error.message}`);
  if (missing) {
    return (
      <PageShell>
        <EmptyState
          icon={<DatabaseZap />}
          title="The error log is not set up yet"
          description="Its table has not been created in the database. Paste supabase/migrations/20261027090000_p17_05_error_logs.sql into the Supabase SQL editor, and errors start arriving here from the next one."
        />
      </PageShell>
    );
  }

  const names = new Map((people.data ?? []).map((person) => [person.id, person.full_name]));
  const rows: ErrorEntry[] = (list.data ?? []).map((row) => ({
    id: row.id,
    when: formatDateTime(row.occurred_at),
    headline: row.message.split("\n")[0],
    message: row.message,
    where: row.path ?? row.route ?? "—",
    route: row.route,
    method: row.method,
    kind_label: errorKindLabel(row.kind),
    source: row.source === "client" ? "client" : "server",
    environment: row.environment,
    environment_label: ENVIRONMENT_LABELS[row.environment as ErrorEnvironment] ?? row.environment,
    who: row.user_id ? (names.get(row.user_id) ?? "A removed account") : null,
    digest: row.digest,
    stack: row.stack,
    user_agent: row.user_agent,
  }));

  const stamps = (summary.data ?? []).map((row) => row.occurred_at);
  const buckets =
    period === "1"
      ? hourlyCounts(stamps, now)
      : dailyCounts(stamps, Number(period), todayInAppZone()).map(({ day, count }) => ({
          // "27 Oct" — the year is noise on a window of at most a month.
          label: formatDate(day).replace(/\s\d{4}$/, ""),
          count,
        }));

  const frequent = topErrors(summary.data ?? []);
  const total = list.count ?? 0;
  const isFiltered = Boolean(term) || Boolean(source) || environment !== DEFAULT_ENVIRONMENT || period !== DEFAULT_PERIOD;
  const where = environment ? ENVIRONMENT_LABELS[environment].toLowerCase() : "everywhere";
  const span = period === "1" ? "the last 24 hours" : `the last ${period} days`;

  function hrefFor(target: number) {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (period !== DEFAULT_PERIOD) next.set("period", period);
    if (params.env && params.env !== DEFAULT_ENVIRONMENT) next.set("env", params.env);
    if (source) next.set("source", source);
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/admin/errors?${query}` : "/admin/errors";
  }

  return (
    <PageShell>
      {/* No <h1>: the breadcrumb names the page. This line says what the audit
          trail cannot — that these are the things that FAILED. */}
      <p className="text-xs text-muted-foreground">
        Everything that failed — a page that would not open, a save that was refused, an error in somebody&apos;s
        browser — with where it happened and who hit it. The audit trail records what succeeded; this records what
        did not. <strong className="font-medium text-foreground">Kept for 30 days.</strong>
      </p>

      {list.error ? (
        <QueryError what="the error log" message={list.error.message} />
      ) : (
        <>
          {/* The chart runs the full width unless there is a "most frequent"
              list to sit beside it — an empty third column is dead space. */}
          <div className={frequent.length > 0 ? "grid gap-4 lg:grid-cols-[2fr_1fr]" : "grid"}>
            <ErrorsChart buckets={buckets} heading={period === "1" ? "Errors per hour" : "Errors per day"} />
            <TopErrors groups={frequent} />
          </div>

          <ErrorsTable
            toolbar={
              <>
                <ListSearch
                  basePath="/admin/errors"
                  className="w-full sm:w-56 lg:w-64"
                  id="errors-search"
                  initial={term}
                  placeholder="Message or page"
                />
                <ErrorFilters environment={environment} period={period} source={source} />
              </>
            }
            count={
              <>
                <span className="tabular-nums">{total}</span> {total === 1 ? "error" : "errors"} {where}, in {span}
              </>
            }
            rows={rows}
            empty={
              isFiltered ? (
                <EmptyState
                  icon={<SearchX />}
                  title="Nothing matches those filters"
                  description="Try Everywhere or a longer period. Search covers the message and the page."
                  action={
                    <Link className={buttonVariants({ size: "sm", variant: "outline" })} href="/admin/errors">
                      Clear filters
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Bug />}
                  title={`No errors on live in ${span}`}
                  description="Nothing has failed. Errors appear here as they happen, from the server and from people's browsers."
                />
              )
            }
          />

          <Pagination basePath="/admin/errors" hrefFor={hrefFor} page={page} pageSize={pageSize} total={total} />
        </>
      )}
    </PageShell>
  );
}

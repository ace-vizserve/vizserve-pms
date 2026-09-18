import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { formatDate, todayInAppZone } from "@/lib/dates";
import { currentBalanceYear, leaveTypeApplies } from "@/lib/schemas/leave-balances";
import { describeLeaveSpan } from "@/lib/schemas/internal-requests";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { Progress } from "@/components/ui/progress";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MyLeaveRecordButton } from "../my-leave-record";
import { MyLeaveTable, type MyLeaveRow } from "./my-leave-table";

export const metadata: Metadata = { title: "My leave" };

/**
 * The caller's own leave balances, on a page.
 *
 * Until this, the figures appeared in exactly two places: inside the filing
 * dialog, one type at a time as you picked it, and in the PDF from "Download my
 * leave record". Neither answers "how much leave do I have" at a glance.
 *
 * ⚠️ NO ARITHMETIC HERE. Allocated / used / remaining come from
 * `vizserve_pms_leave_balance_summary` and are rendered as given — the schema
 * file for balances explains why a client computing an entitlement is the drift
 * the design exists to prevent. Used counts APPROVED leave only; pending
 * requests are listed underneath so they are visible without being deducted.
 */
export default async function MyLeavePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const context = await requireAuthContext();
  const supabase = await createClient();
  const params = await searchParams;

  const thisYear = currentBalanceYear(todayInAppZone());
  // A hand-edited ?year= that is not a sane year falls back to this one.
  const requested = Number(params.year);
  const year =
    Number.isInteger(requested) && requested >= 2020 && requested <= thisYear + 1
      ? requested
      : thisYear;

  const [balancesResult, typesResult, requestsResult] = await Promise.all([
    supabase.rpc("vizserve_pms_leave_balance_summary", { p_year: year }),

    // Only to drop types this person can never take (P7-45) — see below.
    supabase.from("vizserve_pms_leave_types").select("id, label, applies_to_gender"),

    // The year's leave requests, whatever their status. Same year rule as the
    // summary function: a request belongs to the year it STARTS in.
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id, status, start_date, end_date, start_half, end_half, leave_type_id, created_at")
      .eq("requester_id", context.userId)
      .eq("request_type", "LEAVE")
      .gte("start_date", `${year}-01-01`)
      .lte("start_date", `${year}-12-31`)
      .order("start_date", { ascending: false }),
  ]);

  const types = new Map((typesResult.data ?? []).map((type) => [type.id, type]));

  /*
   * A type that does not apply to this person (Paternity for a woman, say) is
   * hidden — UNLESS leave was actually taken against it, which is a fact.
   * An ALLOCATION alone does not keep it: that is days they can never spend,
   * almost always given before their gender was recorded, and it is HR's to
   * zero on /hr/balances, not this person's to be shown.
   */
  const balances = (balancesResult.data ?? []).filter(
    (row) =>
      Number(row.days_used) > 0 ||
      leaveTypeApplies(types.get(row.leave_type_id)?.applies_to_gender, context.gender),
  );

  const requests: MyLeaveRow[] = (requestsResult.data ?? []).map((request) => ({
    id: request.id,
    status: request.status,
    typeLabel: (request.leave_type_id && types.get(request.leave_type_id)?.label) || "Leave",
    when: describeLeaveSpan(
      request.start_date!,
      request.end_date!,
      request.start_half,
      request.end_half,
      formatDate,
    ),
    startDate: request.start_date!,
    filedAt: request.created_at,
  }));

  const yearHref = (target: number) =>
    target === thisYear ? "/approvals/leave" : `/approvals/leave?year=${target}`;

  return (
    <PageShell className="gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border bg-card grade-surface p-1 shadow-raised-lg">
          <Link
            href={yearHref(year - 1)}
            aria-label="Previous year"
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <ChevronLeft />
          </Link>
          <span className="min-w-14 text-center text-sm font-medium tabular-nums">{year}</span>
          {year < thisYear ? (
            <Link
              href={yearHref(year + 1)}
              aria-label="Next year"
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
            >
              <ChevronRight />
            </Link>
          ) : (
            <span className="size-8" aria-hidden />
          )}
        </div>
        <MyLeaveRecordButton year={year} />
      </div>

      <section className="space-y-3" aria-labelledby="balances-heading">
        <div>
          <h2 id="balances-heading" className="text-sm font-semibold">
            Leave balances · {year}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            What HR allocated for the year less your approved leave. Pending requests are not
            deducted until they are approved.
          </p>
        </div>

        {balancesResult.error ? (
          <QueryError what="your leave balances" message={balancesResult.error.message} />
        ) : balances.length === 0 ? (
          <p className="rounded-lg border bg-card grade-surface p-4 text-sm text-muted-foreground shadow-raised-lg">
            No leave types are set up for {year}.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {balances.map((row) => {
              const allocated = Number(row.days_allocated);
              const used = Number(row.days_used);
              const remaining = Number(row.days_remaining);
              const overdrawn = remaining < 0;

              return (
                <li
                  key={row.leave_type_id}
                  className="flex flex-col gap-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium">{row.label}</h3>
                    {!row.is_active ? (
                      <span className="text-2xs text-muted-foreground">Retired</span>
                    ) : null}
                  </div>

                  <p className="flex items-baseline gap-1.5">
                    <span
                      className={cn(
                        "text-2xl font-semibold tabular-nums tracking-[-0.022em]",
                        overdrawn && "text-destructive",
                      )}
                    >
                      {formatDays(remaining)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {overdrawn ? "days over" : Math.abs(remaining) === 1 ? "day left" : "days left"}
                    </span>
                  </p>

                  {allocated > 0 ? (
                    <Progress
                      value={Math.min(100, (used / allocated) * 100)}
                      aria-label={`${row.label}: ${formatDays(used)} of ${formatDays(allocated)} days used`}
                    />
                  ) : null}

                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatDays(used)} used of {formatDays(allocated)} allocated
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <MyLeaveTable
        year={year}
        rows={requests}
        error={
          requestsResult.error ? (
            <QueryError what="your leave requests" message={requestsResult.error.message} />
          ) : null
        }
      />
    </PageShell>
  );
}

/** Whole or half days, as allocations are. `-2` renders as `2` — the label says "over". */
function formatDays(value: number): string {
  return Math.abs(value).toLocaleString("en-PH", { maximumFractionDigits: 1 });
}

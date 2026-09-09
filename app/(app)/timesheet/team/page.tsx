import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { addDays, formatWeekRange, startOfWeek, todayInAppZone, weekDates } from "@/lib/dates";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";

import { TeamView } from "./team-view";

export const metadata: Metadata = { title: "Team week" };

/**
 * P6-05 / slice E1 / P12-23 — the lead's week: the SERVER half, which is auth,
 * the role gate and the week.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THE TEN QUERIES THAT USED TO LIVE HERE ARE IN THE TANSTACK CACHE
 * (`team-view.tsx`, `lib/query/fetchers/timesheet.ts`). What is left is what
 * must not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check.
 *   2. THE ROLE GATE. `roleAtLeast` is re-exported from `lib/auth/authorization.ts`,
 *      which is `server-only`, and a client component deciding whether it is
 *      allowed to render is precisely the "scattered `if (role === 'admin')`"
 *      CLAUDE.md exists to forbid. It is not the enforcement either way — the
 *      policies would return only this person's own rows — it is about not
 *      offering a page that can only ever show one person their own week twice.
 *   3. THE WEEK, read once from the URL and handed down. Re-reading it in the
 *      browser is how a query key and a query drift by one navigation.
 *
 * THE SHAPE IS THE TRANSPOSE of the member's own week: people down the side, the
 * seven days across, totals on both axes. A lead already knows how to read it,
 * because it is the same grid they fill in themselves.
 *
 * NO DEPARTMENT FILTER ON ANY QUERY, and none may be added. Every table scopes
 * by policy through the person the row belongs to; restating the filter would
 * imply the policy is optional, and it is the only thing standing between one
 * lead and another lead's team.
 * ------------------------------------------------------------------------
 */
export default async function TeamWeekPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const context = await requireAuthContext();

  // A member has nobody to review. See the role-gate note above.
  if (!roleAtLeast(context.role, "team_leader")) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">
          This page is for team leaders. Your own week is on{" "}
          <Link href="/timesheet" className="underline">
            the timesheet
          </Link>
          .
        </p>
      </PageShell>
    );
  }

  const params = await searchParams;

  const today = todayInAppZone();
  // Any day in the week works as an anchor and is normalised here, mirroring
  // `/timesheet` and `vizserve_pms_submit_timesheet_week`. `?week=banana` falls
  // back to this week rather than erroring.
  const monday = startOfWeek(params.week ?? today) ?? startOfWeek(today)!;
  const days = weekDates(monday);

  const previousWeek = addDays(monday, -7);
  const nextWeek = addDays(monday, 7);
  const thisWeek = startOfWeek(today);

  function weekHref(target: string | null) {
    return target && target !== thisWeek ? `/timesheet/team?week=${target}` : "/timesheet/team";
  }

  return (
    <PageShell className="gap-3">
      <div className="flex items-center gap-2 rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        <Link
          href={weekHref(previousWeek)}
          aria-label="Previous week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronLeft />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium">{formatWeekRange(monday)}</p>
          {monday === thisWeek ? (
            <p className="text-2xs text-muted-foreground">This week</p>
          ) : (
            <Link href="/timesheet/team" className="text-2xs text-muted-foreground hover:underline">
              Back to this week
            </Link>
          )}
        </div>

        <Link
          href={weekHref(nextWeek)}
          aria-label="Next week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronRight />
        </Link>
      </div>

      <TeamView monday={monday} days={days} today={today} />
    </PageShell>
  );
}

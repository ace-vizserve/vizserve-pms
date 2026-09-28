"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/client-auth";
import { roleAtLeast } from "@/lib/auth/roles";
import { addDays, formatWeekRange, startOfWeek, todayInAppZone, weekDates } from "@/lib/dates";

import { TeamView } from "./team-view";

/**
 * P12 Phase A — the team week, entirely in the browser. The role check is the
 * page's courtesy message for a member who followed a link; RLS is what keeps a
 * member's reads to their own rows either way.
 */
export function TeamPageView() {
  const auth = useAuth();
  const params = { week: useSearchParams().get("week") ?? undefined };

  if (!roleAtLeast(auth.role, "team_leader")) {
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

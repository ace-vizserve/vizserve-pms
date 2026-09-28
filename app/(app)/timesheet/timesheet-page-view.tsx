"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/client-auth";
import { addDays, formatWeekRange, startOfWeek, todayInAppZone, weekDates } from "@/lib/dates";

import { TimesheetView } from "./timesheet-view";

/**
 * P12 Phase A — the timesheet page, entirely in the browser.
 *
 * ⚠️ WHAT USED TO PIN THIS TO THE SERVER, AND WHY IT NO LONGER DOES.
 *   1. The auth context: resolved by `app/(app)/layout.tsx` and read here
 *      through `useAuth()`. The gate still runs there, before anything paints.
 *   2. The week: still a URL parameter, read ONCE here and handed down, so the
 *      query key and the query cannot drift.
 *   3. Today: `todayInAppZone()` formats in `APP_TIME_ZONE` explicitly, so a
 *      browser in any timezone gets Manila's date — the same answer the server
 *      gave.
 */
export function TimesheetPageView() {
  const auth = useAuth();
  const params = { week: useSearchParams().get("week") ?? undefined };

  const today = todayInAppZone();
  // Anything in the week works as an anchor — startOfWeek normalises it. A
  // hand-edited ?week=banana falls back to this week rather than erroring: a bad
  // filter should be ignored, not fatal.
  const monday = startOfWeek(params.week ?? today) ?? startOfWeek(today)!;
  const days = weekDates(monday);

  const previousWeek = addDays(monday, -7);
  const nextWeek = addDays(monday, 7);
  const thisWeek = startOfWeek(today);
  const isCurrentWeek = monday === thisWeek;

  function weekHref(target: string | null) {
    return target && target !== thisWeek ? `/timesheet?week=${target}` : "/timesheet";
  }

  return (
    <PageShell className="gap-3">
      {/* Week navigation. Plain links rather than a client-side picker: the week
          lives in the URL, so back and forward already work and there is no
          state to keep in step with it.

          ⚠️ IT STAYS ON THE SERVER, AND IT IS CHEAP NOW. This page reads nothing
          at all, so following one of these arrows renders a shell and the
          browser answers from the cache if that week is already in it — which is
          the case for the week you just came from. */}
      <div className="flex items-center gap-2 rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        {/* A LINK styled as a button, not a Button rendering a link. Base UI's
            Button is a native <button> unless told otherwise, so
            `render={<Link/>}` hands it an <a> and it warns that the native
            button semantics it promised are gone. The repo settled this at the
            inbox's Clear filters: if it navigates, it is a link, and
            `buttonVariants` is how a link borrows the styling.

            aria-label rather than an sr-only span — the accessible name of a
            link with no text belongs on the link itself. */}
        <Link
          href={weekHref(previousWeek)}
          aria-label="Previous week"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <ChevronLeft />
        </Link>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium">{formatWeekRange(monday)}</p>
          {!isCurrentWeek ? (
            <Link href="/timesheet" className="text-2xs text-muted-foreground hover:underline">
              Back to this week
            </Link>
          ) : (
            <p className="text-2xs text-muted-foreground">This week</p>
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

      <TimesheetView
        userId={auth.userId}
        monday={monday}
        days={days}
        today={today}
        /* Strictly before this week. It chooses which sentence the status bar
           says, not whether it says one: a finished week gets the shortfall
           warning, a week still being worked gets a neutral progress line with
           the same target in it. Either way a submission below the target is
           confirmed first (P8-05b). A FUTURE week cannot be submitted at all,
           so "not current" and "finished" are the same set here. */
        weekHasEnded={thisWeek ? monday < thisWeek : false}
      />
    </PageShell>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { addDays, formatWeekRange, startOfWeek, todayInAppZone, weekDates } from "@/lib/dates";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";

import { TimesheetView } from "./timesheet-view";

export const metadata: Metadata = { title: "Timesheet" };

/**
 * P6-02 / P6-03 / P12-23 — the timesheet: the SERVER half, which is auth and the
 * week and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO CARRY THE WHOLE SCREEN'S DATA — nine queries whose results
 * became eight props, re-run in full by `revalidatePath("/timesheet")` every
 * time somebody typed a number into a cell. P12-23 moved them into the TanStack
 * cache (`timesheet-view.tsx`, `lib/query/fetchers/timesheet.ts`) and left behind
 * exactly the three things that must not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase. It also runs in `app/(app)/layout.tsx` above this;
 *      calling it here is what gives this file the CONTEXT, not what enforces
 *      the gate.
 *   2. THE WEEK. It is a URL parameter like every other filter in the app — a
 *      week someone is looking at should survive a refresh and be pasteable into
 *      a message — and it is read ONCE, here, then handed down. Re-reading it in
 *      the browser with `useSearchParams` is how a query key and a query drift
 *      by one navigation.
 *   3. `todayInAppZone()`. The business runs in Manila and this page renders on
 *      whatever laptop is open; a browser deciding whether a Manila week has
 *      ended would disagree with the row the server rendered. `lib/dates.ts` is
 *      the whole date library here and there is no `dayjs`/`date-fns`.
 *
 * FIRST PERSON ONLY. The RLS policy also lets a department lead READ their
 * team's entries, but there is no person picker here — reading a team's week is
 * a reporting question (P6-05), and answering half of it inside the entry screen
 * is how you end up with a report nobody trusts because it is also an editor.
 * ------------------------------------------------------------------------
 */
export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

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
        userId={context.userId}
        monday={monday}
        days={days}
        today={today}
        /* Strictly before this week. It chooses which sentence the status bar
           says, not whether it says one: a finished week gets the shortfall
           warning, a week still being worked gets a neutral progress line with
           the same target in it. Both matter, because
           `vizserve_pms_submit_timesheet_week` applies the full minimum to the
           CURRENT week and refuses only a future one — so a Thursday submission
           can be refused, and the target must be on screen before it is. A
           FUTURE week cannot be submitted at all, so "not current" and
           "finished" are the same set here. */
        weekHasEnded={thisWeek ? monday < thisWeek : false}
      />
    </PageShell>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { QueryError } from "@/components/query-error";
import { TeamWeekGridSkeleton } from "@/components/skeletons";
import { browserClient } from "@/lib/query/browser-client";
import { fetchTeamWeek } from "@/lib/query/fetchers/timesheet";
import { qk } from "@/lib/query/keys";

import { TeamWeekGrid } from "./team-week-grid";

/**
 * P6-05 / slice E1 / P12-23 — the lead's week, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED. `page.tsx` was a 591-line RSC holding TEN queries — every
 * timesheet entry for the whole team-week with a task embed, every DTR row for
 * the week, the leave calendar, three name lookups — none of it paginated, and
 * all of it re-run by `revalidatePath("/timesheet/team")` every time a lead
 * pressed Approve on one person. It is one query key now, and a decision patches
 * the row it was pressed on.
 *
 * ⚠️ THE DERIVATION WENT WITH THE READS, WHICH IS THE OPPOSITE CALL FROM THE
 * MEMBER'S OWN WEEK. `fetchTeamWeek` returns finished `TeamRow`s rather than raw
 * entries, and `lib/query/fetchers/timesheet.ts` argues it: the member's grid is
 * TYPED INTO, so its cache entry has to hold entries an `onMutate` can patch;
 * nothing here edits an hour, because the write policies on
 * `vizserve_pms_timesheet_entries` are owner-only. The only write on this screen
 * is a decision on a WEEK, which is one field on one row.
 *
 * ⚠️ AUTHENTICATION AND THE ROLE GATE DID NOT MOVE. `requireAuthContext()` and
 * the team-leader check run in `page.tsx`; this component makes no decision about
 * who may see what, and the queries below carry no department filter because the
 * policies scope every table through the person the row belongs to.
 * ------------------------------------------------------------------------
 */
export function TeamView({
  monday,
  days,
  today,
}: {
  monday: string;
  days: string[];
  today: string;
}) {
  const teamKey = qk.teamWeekVisible(monday);

  const weekQuery = useQuery({
    queryKey: teamKey,
    // `browserClient()` inside the `queryFn`, never in the body — a client
    // component still renders on the server for its initial HTML.
    queryFn: () => fetchTeamWeek(browserClient(), { monday }),
  });

  /* A failed read rendering as "nobody logged anything" is the specific failure
     this app keeps having. Named rather than swallowed. */
  if (weekQuery.isError) {
    return <QueryError what="this week" message={weekQuery.error.message} />;
  }

  /* `isPending` is "no data yet", not "fetching": a refetch after a decision
     must not replace the grid a lead is reading with a skeleton. */
  if (weekQuery.isPending) return <TeamWeekGridSkeleton />;

  const { rows, punchesLoaded, punchesError, settingsFellBack } = weekQuery.data;

  return (
    <>
      {/* P8-07 — a dead DTR read must not read as "nobody punched". `?? []`
          would put an empty punch record beside a full week of logged hours,
          which is an accusation the page has no evidence for. Said out loud
          here, and `punchesLoaded={false}` stops the grid printing "no punch" in
          fourteen cells underneath it.

          Not a QueryError: the hours themselves loaded, and withholding the
          whole review because one comparison failed would be the worse trade. */}
      {!punchesLoaded ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          Punched hours could not be loaded, so this week cannot be compared against the DTR. This is
          a fault, not an empty record — nobody is shown as having failed to punch. Give whoever is
          on support this message: <code className="text-2xs">{punchesError}</code>
        </p>
      ) : null}

      {/* P8-07 — the break the punched figures are compared with, when it could
          not be read.

          `readAppSettings` degrades to the migration's own default instead of
          throwing, on purpose: three other screens would go down otherwise. But
          a punched span less a break NOBODY READ is a fabricated number, and it
          would be printed beside somebody's logged hours as a difference their
          lead is invited to act on. So the comparison is withheld for everyone
          inheriting that figure and the reason is said out loud — the same
          posture, and the same sentence shape, as the shortfall banner on
          `/timesheet`.

          Anyone with their OWN break on their user row is unaffected: that
          figure was read, and their row still compares. */}
      {settingsFellBack && punchesLoaded ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          The company break setting could not be loaded, so punched hours are not compared against
          logged hours for anyone who inherits it. The hours on both records are unaffected —
          nobody is shown as having failed to punch.
        </p>
      ) : null}

      <TeamWeekGrid
        monday={monday}
        days={days}
        today={today}
        rows={rows}
        teamKey={teamKey}
        punchesLoaded={punchesLoaded}
      />
    </>
  );
}

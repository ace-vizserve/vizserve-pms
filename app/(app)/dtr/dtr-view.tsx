"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Clock } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { TableSkeleton } from "@/components/skeletons";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatDuration } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import { DTR_PAGE_SIZE, fetchDtrView, type DtrSort } from "@/lib/query/fetchers/dtr";
import { fetchDirectory } from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";

import { DtrTable } from "./dtr-table";
import { DtrToolbar } from "./dtr-toolbar";

/**
 * P5-04 / P12-23 — the daily time record, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED. `page.tsx` was a 918-line RSC: five queries, two Suspense
 * boundaries fed by one shared promise, and every derivation. Changing the date
 * range re-rendered the whole route; a punch went through
 * `revalidatePath("/dtr")` and re-read five hundred days to move one time-in.
 *
 * ⚠️ THE SPLIT THE RSC ALREADY MADE IS THE SPLIT THE KEYS MAKE. Its own note
 * said it: "the punch panel is the thing people open this page to CLICK, and it
 * was waiting on a five-hundred-row read it shares nothing with". The panel is
 * `qk.punchState()`, seeded on the server and shared with `/`, `/dashboard` and
 * the shell's clock reminder; the record is `qk.dtrView(filters)`. Two keys, two
 * refetch schedules, and the panel no longer waits for the table.
 *
 * ⚠️ THE PUNCH PANEL ARRIVES AS A PROP, ALREADY RENDERED. It has to be built in
 * the RSC so `loadPunchState` can seed its cache entry before hydration — which
 * is the "start the request on the server, do not await it in the browser"
 * shape — and it has to sit INSIDE this rail, above the filters. Passing the
 * element down is how both are true at once.
 *
 * ⚠️ SCOPE IS RLS'S JOB. Every query behind this carries no department filter
 * and no `user_id = me` clause: the policy returns your own rows plus your
 * team's if you lead one. `isLead` below decides whether a PICKER is offered,
 * which is a presentation question — a member has nobody else to look at, and
 * the policy would refuse them anyway.
 * ------------------------------------------------------------------------
 */
export function DtrView({
  punchPanel,
  viewerId,
  from,
  to,
  selectedUser,
  sort,
  ascending,
  rangeInverted,
  isLead,
}: {
  /** `<PunchPanel initial={…} viewerId={…} />`, built in the RSC. See above. */
  punchPanel: React.ReactNode;
  viewerId: string;
  from: string;
  to: string;
  selectedUser: string | null;
  sort: DtrSort;
  ascending: boolean;
  rangeInverted: boolean;
  isLead: boolean;
}) {
  const view = useQuery({
    /*
     * ⚠️ EVERY FILTER IS IN THE KEY BECAUSE EVERY FILTER CHANGES THE ROWS. The
     * query is capped at `DTR_PAGE_SIZE + 1` and Postgres does the ordering, so
     * a re-sort is genuinely a different result set rather than the same rows
     * rearranged — sorting the truncated page in the browser would claim an
     * ordering of days it never received. `normalize` inside `qk.dtrView` is
     * what stops an absent `?user=` and one set to `""` becoming two entries.
     */
    queryKey: qk.dtrView({
      from,
      to,
      user: selectedUser ?? undefined,
      sort,
      dir: ascending ? "asc" : "desc",
    }),
    // `browserClient()` inside the `queryFn`, never in the body — a client
    // component still renders on the server for its initial HTML.
    queryFn: () =>
      fetchDtrView(browserClient(), {
        from,
        to,
        selectedUser,
        sort,
        ascending,
        rangeInverted,
        isLead,
      }),
  });

  /*
   * ⚠️ THE PERSON PICKER READS THE SHARED DIRECTORY, NOT THIS PAGE'S OWN PEOPLE.
   *
   * `fetchDtrView` also reads names — it has to, because the leave-only rows it
   * synthesises have no punch row to take a name from — and the RSC shared ONE
   * promise between the two uses. They are split here on purpose: the filters
   * must paint immediately, and waiting for a five-hundred-row read to draw a
   * dropdown is the exact coupling the Suspense boundary in the RSC existed to
   * break. `qk.ref("users")` is app-wide reference data on a ten-minute
   * `staleTime`, already warm on any tab that has visited `/tasks`, so this is
   * usually not a request at all.
   *
   * ⚠️ `is_active` IS FILTERED HERE RATHER THAN IN SQL. `fetchDirectory`
   * deliberately returns deactivated people — `/tasks` resolves comment authors
   * and history actors through the same entry, and those are exactly the people
   * who leave — so the three consumers that need the ACTIVE set narrow it
   * themselves. Offering a deactivated colleague in this picker would offer a
   * filter that matches nothing.
   *
   * Gated on `isLead`, so a member issues no request for a control they will
   * never see.
   */
  const directory = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
    enabled: isLead,
  });

  /*
   * ⚠️ `?? []` HERE IS A LEGAL DEFAULT ONLY BECAUSE THE FAILURE IS SAID OUT LOUD
   * BELOW. On its own it is the exact P12-01 trap: an empty directory hides the
   * person picker entirely (`people.length > 0` in the toolbar), so a lead whose
   * directory read failed would find the control simply absent and conclude
   * there is nobody in their scope. The banner in the rail is what makes the two
   * cases different on screen.
   */
  const people = (directory.data ?? [])
    .filter((person) => person.is_active)
    .map((person) => ({ id: person.id, full_name: person.full_name }));

  const showPerson = isLead && !selectedUser;

  return (
    /*
      From `lg` up this page does not scroll — it fits the viewport and the table
      scrolls inside its own card.

      The height comes from flexbox, not from `calc(100svh - …)`. The shell is
      already a chain of `flex-1` boxes inside a `min-h-svh` provider, so
      `lg:flex-1 lg:min-h-0` here inherits the exact remaining height with no
      arithmetic to get wrong. Guessing at the header and padding is what put a
      scrollbar on a page that had nothing to scroll to.

      `min-h-0` is the load-bearing half: a flex child's default `min-height:
      auto` refuses to shrink below its content, so without it the table pushes
      the page taller instead of scrolling inside itself.

      Below `lg` this all switches off and the page scrolls normally — a fixed
      viewport with two scroll regions on a phone is a trap.
    */
    <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
      {/*
        The left rail. It used to hold the punch panel alone, which is about
        200px tall against a table that runs thirty rows — the rest of that
        column was empty page for the entire scroll.

        The filters moved into it, so the rail is punch + range + export and the
        table gets the whole width of the right column. That is also the better
        home for them: a date range you are adjusting while reading the rows
        should not be a screen-length scroll away from the rows.

        It scrolls itself rather than sticking to the page: with the page height
        pinned to the viewport there is no page scroll for a sticky element to
        hold still against, and a short window still has to be able to reach the
        Export button.
      */}
      <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
        {punchPanel}

        {/* See the note on `people` above: without this, a failed directory read
            takes the person picker off the screen with no explanation, which
            reads as "there is nobody else in your scope". The dates and the
            export are unaffected, so the toolbar still renders. */}
        {directory.isError ? (
          <p
            role="status"
            className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
            The staff list could not be loaded, so the person filter is not available. Your own
            record and everything below are unaffected.{" "}
            <code className="text-2xs">{directory.error.message}</code>
          </p>
        ) : null}

        <DtrToolbar people={people} from={from} to={to} userId={selectedUser} canExport={isLead} />

        <DtrRailSummary view={view} />

        {/* Kept from the old page heading. It is not decoration: it is why two
            punches on one day collapse into one row, which is the first thing
            anyone asks about their own record. Beside the rail it explains the
            table without costing the table any height. */}
        <p className="px-1 text-xs text-muted-foreground">
          Times are captured by the server — the earliest time-in and the latest time-out for each
          day are what stand.
        </p>
      </div>

      {/* Density lives here, not in components/ui/table.tsx. The shared table is
          `h-10` headers and `p-2` cells because that suits the six other lists in
          the app; the DTR is the one screen people read thirty rows of at a
          time, so it gets tighter rows without dragging Requests and Tasks along
          with it. */}
      <DtrTableSection
        view={view}
        viewerId={viewerId}
        showPerson={showPerson}
        from={from}
        to={to}
        selectedUser={selectedUser}
        rangeInverted={rangeInverted}
      />
    </div>
  );
}

type ViewQuery = ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchDtrView>>>>;

/**
 * ⚠️ A LOADING REGION IS ANNOUNCED BY NOBODY HERE.
 *
 * `components/skeletons.tsx` hides its skeletons from assistive technology, and
 * the reason it gives is specific to `loading.tsx`: the ROUTER announces that
 * navigation, so a second announcement would interrupt it. Nothing announces a
 * query settling inside a page that has already rendered — so these are
 * `role="status"` regions carrying `aria-busy` and a label, and only the grey
 * bars inside them are `aria-hidden`. The label names which part of the page is
 * still coming, because two of them are on screen at once.
 */
function DtrSummaryFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      <span className="sr-only">Loading the totals for this range…</span>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5" aria-hidden>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-1.5">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The rail's warnings and totals. Everything above them is already on screen. */
function DtrRailSummary({ view }: { view: ViewQuery }) {
  /* The table below says the same failure at length and in the place somebody
     is looking. Two `QueryError`s for one query would be the screen shouting. */
  if (view.isError) return null;
  if (view.isPending) return <DtrSummaryFallback />;

  const {
    truncated,
    leaveError,
    entries,
    punchCount,
    totalMinutes,
    averageMinutes,
    stillOpen,
    leaveDayCount,
  } = view.data;

  return (
    <>
      {/* Said before the numbers, not after them. Somebody reading a total that
          covers only part of the range needs to know that before they act on it
          — and the CSV export is not capped, so the export and this screen will
          disagree until the range is narrowed. */}
      {truncated ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          More than {DTR_PAGE_SIZE} records match this range, so the list and the totals below cover
          only the most recent {DTR_PAGE_SIZE}. Narrow the dates, or pick one person, to see the
          rest. Export gives you the whole range.
        </p>
      ) : null}

      {/* Said out loud rather than swallowed. A failed leave query renders as a
          record with no leave in it, which is indistinguishable from nobody
          having taken any — the exact "data ?? [] reads as empty" trap that hid
          the broken embed on this page for months. */}
      {leaveError ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          Approved leave could not be loaded, so days away are not shown below. The punch records
          are unaffected. <code className="text-2xs">{leaveError}</code>
        </p>
      ) : null}

      {/* What fills the rest of the rail. The table already totals itself in a
          footer row, but that footer is at the bottom of thirty rows — which is
          no use to the person who opened this page to find out how many hours
          the range came to. Same number, read without scrolling.

          Only when there is something to summarise: four dashes under an empty
          table is furniture, not information. */}
      {entries.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
          <div>
            <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Records</dt>
            {/* Punch records only. The leave rows below are days in the list but
                not days at work, and adding them here would overstate the figure
                people read as attendance. */}
            <dd className="mt-0.5 text-sm font-semibold tabular-nums">{punchCount}</dd>
          </div>
          <div>
            <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
              {truncated ? "Total shown" : "Total"}
            </dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums">
              {formatDuration(totalMinutes)}
            </dd>
          </div>
          <div>
            <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Average</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums">
              {formatDuration(averageMinutes)}
            </dd>
          </div>
          <div>
            <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Still open</dt>
            {/* Stated in words as well as colour — a warning-coloured number is
                not a status on its own. */}
            <dd
              className={
                stillOpen > 0
                  ? "mt-0.5 text-sm font-semibold tabular-nums text-warning"
                  : "mt-0.5 text-sm font-semibold tabular-nums"
              }>
              {stillOpen}
              {stillOpen > 0 ? <span className="sr-only"> days not timed out</span> : null}
            </dd>
          </div>

          {/* Only when there is leave in the range. A permanent "0" here would be
              a stat that is furniture on most weeks. */}
          {leaveDayCount > 0 ? (
            <div>
              <dt className="text-2xs tracking-wide text-muted-foreground uppercase">On leave</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-info">
                {leaveDayCount}
                <span className="sr-only"> approved days away with no punch</span>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </>
  );
}

/** The right column, and the five-hundred-row read that is the point of the split. */
function DtrTableSection({
  view,
  viewerId,
  showPerson,
  from,
  to,
  selectedUser,
  rangeInverted,
}: {
  view: ViewQuery;
  viewerId: string;
  showPerson: boolean;
  from: string;
  to: string;
  selectedUser: string | null;
  rangeInverted: boolean;
}) {
  if (view.isPending) {
    return (
      <div role="status" aria-busy="true" className="lg:min-h-0">
        <span className="sr-only">Loading the time record…</span>
        <TableSkeleton columns={5} rows={8} />
      </div>
    );
  }

  const entries = view.isError ? [] : view.data.entries;
  const truncated = view.isError ? false : view.data.truncated;
  const totalMinutes = view.isError ? 0 : view.data.totalMinutes;

  return (
    <DtrTable
      // The card fills the row and the rows scroll inside it, so five hundred
      // days of DTR never make the page itself longer.
      //
      // ⚠️ `[&>div:last-child]`, NOT `[&>div]`, AND THAT ONE WORD IS THE WHOLE
      // BUG THIS COMMENT USED TO DESCRIBE WRONGLY.
      //
      // It said "`[&>div]` is DataTableShell's inner scroller". The shell has
      // TWO direct div children whenever there is a controls strip: the strip
      // itself, and the `overflow-x-auto` scroller holding the table. `[&>div]`
      // matched both — so the TOOLBAR got `h-full` and filled the card, and the
      // table was pushed out of a container that is `overflow-hidden`. The
      // result was a DTR showing its Columns button and nothing else, at `lg`
      // and up, with the rows present in the DOM and no error anywhere to
      // explain it.
      //
      // `:last-child` is the scroller in both cases — the strip is conditional
      // (`hasStrip`), so when it is absent the scroller is still the last child
      // and still the only one.
      //
      // The scroller already handles the horizontal axis, which is why the
      // vertical one belongs on it rather than in a second scroll container
      // nested inside.
      //
      // The header sticks to the top of that scroller. `bg-background` and the
      // inset shadow rather than a border: a sticky `th` keeps its own
      // background but a `border-b` declared on the `tr` does not travel with
      // it, so the rule under the headings vanishes on first scroll.
      //
      // `[&_table]:h-full` ONLY when empty — it stretches the table to the card
      // so the empty state centres in it. Left on with rows present it would
      // stretch the ROWS instead, and a three-row range would render as three
      // 200px-tall bands.
      className={`[&_td]:px-2 [&_td]:py-1 [&_th]:h-8 [&_th]:px-2 lg:h-full lg:min-h-0 lg:[&>div:last-child]:h-full lg:[&>div:last-child]:overflow-y-auto lg:[&_thead_th]:sticky lg:[&_thead_th]:top-0 lg:[&_thead_th]:z-10 lg:[&_thead_th]:bg-background lg:[&_thead_th]:shadow-[inset_0_-1px_0_var(--border)] ${
        entries.length === 0 ? "lg:[&_table]:h-full" : ""
      }`}
      rows={entries}
      viewerId={viewerId}
      showPerson={showPerson}
      empty={
        view.isError ? (
          <QueryError what="your time record" message={view.error.message} />
        ) : rangeInverted ? (
          // Deliberately NOT swapped behind their back. Silently answering a
          // different question than the one asked is how somebody ends up
          // trusting a range they never set.
          <EmptyState
            className="py-10"
            icon={<Clock />}
            title="That range runs backwards"
            description={`From is ${formatDate(from)} and To is ${formatDate(to)}, so no day can fall inside it. This is not an empty record — swap the two dates to see what is there.`}
            action={
              <Link
                href={`/dtr?from=${to}&to=${from}${selectedUser ? `&user=${selectedUser}` : ""}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}>
                Swap the dates
              </Link>
            }
          />
        ) : (
          <EmptyState
            // No min-height of its own. The table above is stretched to the card
            // while the list is empty, and TableCell's `align-middle` does the
            // centring — which cannot drift out of step with the layout the way
            // a hardcoded viewport figure did.
            className="py-10"
            icon={<Clock />}
            title="No entries in this range"
            description="Days with no punch have no row at all, apart from approved leave, which is listed. Widen the date range first — if a day is genuinely missing that should not be, raise the correction from here."
            action={
              // F. It carries `from`, the first day of the range being looked
              // at, because that is the only day this screen can name — an empty
              // range has no row to take a date off. The dialog opens on it and
              // the person changes it if they meant another day, which is still
              // one field instead of four steps.
              <Link
                href={`/approvals?type=NO_TIME_IN&date=${from}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}>
                Raise a No Time-In request
              </Link>
            }
          />
        )
      }
      totalLabel={truncated ? `Total of the first ${DTR_PAGE_SIZE} shown` : "Total in range"}
      totalMinutes={totalMinutes}
    />
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Clock } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import {
  addDays,
  formatAppTime,
  formatDate,
  formatDuration,
  todayInAppZone,
  workedMinutes,
} from "@/lib/dates";
import { loadPunchState } from "@/lib/dtr-server";
import { createClient } from "@/utils/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { DtrToolbar } from "./dtr-toolbar";
import { PunchPanel } from "./punch-panel";

export const metadata: Metadata = { title: "DTR" };

/**
 * How many rows the list renders. The query asks for one more, so truncation is
 * detectable without a second count query.
 */
const DTR_PAGE_SIZE = 500;

/**
 * P5-04 — the daily time record.
 *
 * "Default view nyan, pag-click, is yung list view lang ng mga time in, time
 * out" (Amier, 19:10). A list of days, not a calendar and not a chart — this is
 * the screen someone opens to check whether yesterday recorded properly.
 *
 * SCOPE IS RLS'S JOB. This query carries no department filter and no
 * `user_id = me` clause: the policy returns your own rows plus your team's if
 * you lead one. Restating that here would imply the policy is optional, and
 * would drift from it the first time either changed.
 */
export default async function DtrPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; user?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const today = todayInAppZone();
  // Default to the last 30 days rather than the calendar month: on the 1st, a
  // month-to-date view is one row and looks broken.
  const from = params.from ?? addDays(today, -29)!;
  const to = params.to ?? today;
  const selectedUser = params.user ?? null;

  // A range that runs backwards matches nothing, and "nothing" is exactly what
  // an honestly empty record looks like — so the page has to say which it is.
  // `dtrExportSchema` already refuses `to < from`; this is the screen catching
  // up with the export rather than quietly disagreeing with it.
  const rangeInverted = from > to;

  const isLead = roleAtLeast(context.role, "team_leader");

  const [punchState, entriesResult, peopleResult] = await Promise.all([
    loadPunchState(context.userId),
    (() => {
      // ONE MORE THAN WE RENDER.
      //
      // The cap has to exist — an unbounded query over a whole department and
      // an arbitrary date range is how a page falls over. But a silent cap on
      // THIS page is worse than most, because the rail and the footer add up
      // the rows that came back and present the result as "Total in range". A
      // lead looking at sixteen people over thirty days is already near 480
      // rows; past the cap the total quietly understates, and it is a payroll
      // number.
      //
      // Asking for PAGE_SIZE + 1 makes truncation detectable without a second
      // count query: if the extra row arrives, there is more than we are
      // showing, and the screen has to say so rather than do arithmetic on a
      // slice and call it a total.
      let query = supabase
        .from("vizserve_pms_dtr_entries")
      // THE FK MUST BE NAMED. `vizserve_pms_dtr_entries` has TWO foreign keys
      // to `vizserve_pms_users` — `user_id` and `corrected_by` — so an
      // unqualified embed is ambiguous and PostgREST refuses the whole query
      // with "more than one relationship was found".
      //
      // This shipped broken and looked empty for months: the page read
      // `data ?? []` and rendered "No entries in this range", which is exactly
      // what an empty record looks like. Naming the constraint is the fix;
      // surfacing query errors (QueryError) is what made it visible.
      //
      // Left embed rather than `!inner`, for the same reason as the timesheet:
      // a row whose person is out of scope should lose its name, not its hours.
        .select(
          "id, work_date, time_in, time_out, corrected_at, user_id, vizserve_pms_users!vizserve_pms_dtr_entries_user_id_fkey(full_name)",
        )
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: false })
        .limit(DTR_PAGE_SIZE + 1);

      if (selectedUser) query = query.eq("user_id", selectedUser);
      return query;
    })(),
    // The picker only makes sense for someone who can see more than themselves.
    // Reads through the same RLS as the list, so it cannot offer a person whose
    // rows would then come back empty.
    isLead
      ? supabase
          .from("vizserve_pms_users")
          .select("id, full_name")
          .eq("is_active", true)
          .order("full_name")
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
  ]);

  type Entry = {
    id: string;
    work_date: string;
    time_in: string | null;
    time_out: string | null;
    corrected_at: string | null;
    user_id: string;
    vizserve_pms_users: { full_name: string } | null;
  };

  const fetched = (entriesResult.data ?? []) as unknown as Entry[];
  // The extra row is a signal, not data. Drop it before anything is counted.
  const truncated = fetched.length > DTR_PAGE_SIZE;
  const entries = truncated ? fetched.slice(0, DTR_PAGE_SIZE) : fetched;

  const people = peopleResult.data ?? [];
  const showPerson = isLead && !selectedUser;

  const totalMinutes = entries.reduce(
    (sum, entry) => sum + (workedMinutes(entry.time_in, entry.time_out) ?? 0),
    0,
  );

  // The rail summary. "Records" rather than "Days" on purpose: with the person
  // filter on Everyone, one calendar day is several rows, and calling that a day
  // count would be wrong in exactly the view a team leader uses most.
  //
  // The average divides by records that actually closed. Dividing by all of them
  // would quietly drag the figure down every time somebody forgot to time out —
  // which is the very thing "Still open" is there to point at.
  const closed = entries.filter((entry) => workedMinutes(entry.time_in, entry.time_out) !== null);
  const stillOpen = entries.filter((entry) => entry.time_in && !entry.time_out).length;
  const averageMinutes = closed.length > 0 ? Math.round(totalMinutes / closed.length) : null;

  const columns: Column<Entry>[] = [
    {
      key: "date",
      header: "Date",
      className: "whitespace-nowrap",
      cell: (entry) => (
        <>
          {formatDate(entry.work_date)}
          {/* Provenance in words. A corrected time is a different fact from a
              punched one, and this is the row someone points at in a payroll
              dispute. */}
          {entry.corrected_at ? (
            <p className="mt-0.5 text-2xs font-medium text-info">Corrected</p>
          ) : null}
        </>
      ),
    },
    // Only when the list spans more than one person. A column of your own name
    // repeated forty times is a column carrying no information.
    ...(showPerson
      ? [
          {
            key: "person",
            header: "Person",
            cell: (entry: Entry) => entry.vizserve_pms_users?.full_name ?? "—",
          },
        ]
      : []),
    {
      key: "in",
      header: "Time in",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => formatAppTime(entry.time_in),
    },
    {
      key: "out",
      header: "Time out",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => (
        <>
          {formatAppTime(entry.time_out)}
          {Boolean(entry.time_in) && !entry.time_out ? (
            <p className="mt-0.5 text-2xs font-medium text-warning">Still open</p>
          ) : null}
        </>
      ),
    },
    {
      key: "worked",
      header: "Worked",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => formatDuration(workedMinutes(entry.time_in, entry.time_out)),
    },
  ];

  return (
    /*
      From `lg` up this page does not scroll — it fits the viewport and the
      table scrolls inside its own card.

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
    <PageShell className="gap-3 lg:overflow-hidden">
      <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        {/*
          The left rail. It used to hold the punch panel alone, which is about
          200px tall against a table that runs thirty rows — the rest of that
          column was empty page for the entire scroll.

          The filters moved into it, so the rail is punch + range + export and
          the table gets the whole width of the right column. That is also the
          better home for them: a date range you are adjusting while reading the
          rows should not be a screen-length scroll away from the rows.

          It scrolls itself rather than sticking to the page now: with the page
          height pinned to the viewport there is no page scroll for a sticky
          element to hold still against, and a short window still has to be able
          to reach the Export button.
        */}
        <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
          <PunchPanel initial={punchState} />

          <DtrToolbar
            people={people}
            from={from}
            to={to}
            userId={selectedUser}
            canExport={isLead}
          />

          {/* Said before the numbers, not after them. Somebody reading a total
              that covers only part of the range needs to know that before they
              act on it — and the CSV export is not capped, so the export and
              this screen will disagree until the range is narrowed. */}
          {truncated ? (
            <p
              role="status"
              className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
            >
              More than {DTR_PAGE_SIZE} records match this range, so the list and the totals below
              cover only the most recent {DTR_PAGE_SIZE}. Narrow the dates, or pick one person, to
              see the rest. Export gives you the whole range.
            </p>
          ) : null}

          {/* What fills the rest of the rail. The table already totals itself in
              a footer row, but that footer is at the bottom of thirty rows —
              which is no use to the person who opened this page to find out how
              many hours the range came to. Same number, read without scrolling.

              Only when there is something to summarise: four dashes under an
              empty table is furniture, not information. */}
          {entries.length > 0 ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
              <div>
                <dt className="text-2xs tracking-wide text-muted-foreground uppercase">Records</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">{entries.length}</dd>
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
                <dt className="text-2xs tracking-wide text-muted-foreground uppercase">
                  Still open
                </dt>
                {/* Stated in words as well as colour — a warning-coloured number
                    is not a status on its own. */}
                <dd
                  className={
                    stillOpen > 0
                      ? "mt-0.5 text-sm font-semibold tabular-nums text-warning"
                      : "mt-0.5 text-sm font-semibold tabular-nums"
                  }
                >
                  {stillOpen}
                  {stillOpen > 0 ? <span className="sr-only"> days not timed out</span> : null}
                </dd>
              </div>
            </dl>
          ) : null}

          {/* Kept from the old page heading. It is not decoration: it is why two
              punches on one day collapse into one row, which is the first thing
              anyone asks about their own record. Beside the rail it explains the
              table without costing the table any height. */}
          <p className="px-1 text-xs text-muted-foreground">
            Times are captured by the server — the earliest time-in and the latest time-out for
            each day are what stand.
          </p>
        </div>

        {/* Density lives here, not in components/ui/table.tsx. The shared table
            is `h-10` headers and `p-2` cells because that suits the six other
            lists in the app; the DTR is the one screen people read thirty rows
            of at a time, so it gets tighter rows without dragging Requests and
            Tasks along with it.

            Descendant selectors rather than a `size` prop on DataTable — one
            page wanting denser rows does not justify a new API on the shared
            component, and the day a second page wants it, that is the moment
            to add one. */}
        <DataTable
          // The card fills the row and the rows scroll inside it, so five
          // hundred days of DTR never make the page itself longer.
          //
          // `[&>div]` is DataTableShell's inner scroller — it already handles
          // the horizontal axis, so it is the right place to add the vertical
          // one rather than nesting a second scroll container inside it.
          //
          // The header sticks to the top of that scroller. `bg-background` and
          // the inset shadow rather than a border: a sticky `th` keeps its own
          // background but a `border-b` declared on the `tr` does not travel
          // with it, so the rule under the headings vanishes on first scroll.
          //
          // `[&_table]:h-full` ONLY when empty — it stretches the table to the
          // card so the empty state centres in it. Left on with rows present it
          // would stretch the ROWS instead, and a three-row range would render
          // as three 200px-tall bands.
          className={`[&_td]:px-2 [&_td]:py-1 [&_th]:h-8 [&_th]:px-2 lg:h-full lg:min-h-0 lg:[&>div]:h-full lg:[&>div]:overflow-y-auto lg:[&_thead_th]:sticky lg:[&_thead_th]:top-0 lg:[&_thead_th]:z-10 lg:[&_thead_th]:bg-background lg:[&_thead_th]:shadow-[inset_0_-1px_0_var(--border)] ${
            entries.length === 0 ? "lg:[&_table]:h-full" : ""
          }`}
          columns={columns}
          rows={entries}
          getRowKey={(entry) => entry.id}
          empty={
            entriesResult.error ? (
              <QueryError what="your time record" message={entriesResult.error.message} />
            ) : 
            rangeInverted ? (
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
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Swap the dates
                  </Link>
                }
              />
            ) : (
            <EmptyState
              // No min-height of its own any more. The table above is stretched
              // to the card while the list is empty, and TableCell's
              // `align-middle` does the centring — which cannot drift out of
              // step with the layout the way a hardcoded viewport figure did.
              className="py-10"
              icon={<Clock />}
              title="No entries in this range"
              description="Days with no punch have no row at all. Widen the date range first; if a day is genuinely missing that should not be, raise a No Time-In request from Approvals."
            />
            )
          }
          footer={
            <TableRow className="hover:bg-transparent">
              <TableHead scope="row" colSpan={columns.length - 1}>
                {truncated ? `Total of the first ${DTR_PAGE_SIZE} shown` : "Total in range"}
              </TableHead>
              <TableCell className="font-semibold tabular-nums">
                {formatDuration(totalMinutes)}
              </TableCell>
            </TableRow>
          }
        />
      </div>
    </PageShell>
  );
}

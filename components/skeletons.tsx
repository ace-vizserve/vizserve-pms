import { DataTableShell } from "@/components/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Loading skeletons for `loading.tsx`.
 *
 * The template writes these inline per route as bare `<Skeleton>` divs. Ours are
 * shared for the same reason `DataTable` is: eight hand-rolled copies of "a
 * table of grey bars" is eight things to update the next time the table shell
 * changes, and a skeleton that no longer matches its real layout is worse than
 * none — the content visibly jumps when it arrives.
 *
 * These are decoration in the strict sense, so they are hidden from assistive
 * technology. Next's `loading.tsx` boundary already announces the navigation;
 * a screen reader enumerating twenty grey rectangles adds nothing.
 */

/** A table's shell, header and N placeholder rows. */
export function TableSkeleton({ columns = 4, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <DataTableShell>
      <Table aria-hidden>
        <TableHeader>
          <TableRow>
            {Array.from({ length: columns }, (_, index) => (
              <TableHead key={index}>
                <Skeleton className="h-3 w-20" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, row) => (
            <TableRow key={row} className="hover:bg-transparent">
              {Array.from({ length: columns }, (_, column) => (
                <TableCell key={column}>
                  {/* The first column is wider in every real table here, and a
                      skeleton with uniform bars reads as a different layout
                      than the one that replaces it. */}
                  <Skeleton className={column === 0 ? "h-4 w-48" : "h-4 w-24"} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}

/** The filter bar that sits above most lists. */
export function FilterBarSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div
      className="flex flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg"
      aria-hidden
    >
      {Array.from({ length: fields }, (_, index) => (
        <div key={index} className="space-y-1.5">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-8 w-44" />
        </div>
      ))}
    </div>
  );
}

/** A row of dashboard stat tiles. */
export function StatRowSkeleton({ tiles = 3 }: { tiles?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: tiles }, (_, index) => (
        <div
          key={index}
          className="flex items-start gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg"
        >
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A titled card with a body — the detail-page unit. */
export function CardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-4 rounded-lg border bg-card grade-surface py-4 shadow-raised-lg" aria-hidden>
      <div className="px-4">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="space-y-3 px-4">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={index === lines - 1 ? "h-4 w-2/3" : "h-4 w-full"} />
        ))}
      </div>
    </div>
  );
}

/*
 * ⚠️ THE TWO BELOW ARE FOR `<Suspense>`, NOT FOR `loading.tsx`, and the
 * accessibility note at the top of this file DOES NOT REACH THEM.
 *
 * `loading.tsx` is announced by the ROUTER — that is why everything above is
 * `aria-hidden`. A Suspense fallback rendered *inside* a page is announced by
 * nothing at all, so the caller wraps these in a `role="status"` region with an
 * accessible label. The visual bars stay `aria-hidden` (twenty grey rectangles
 * enumerated one by one is not a loading message); the label is what speaks.
 *
 * Both shapes are lifted from the `loading.tsx` that already draws them, so the
 * router's placeholder and the page's stream into the same layout and neither
 * one jumps on the way to the other.
 */

/**
 * The task list's stage groups — `app/(app)/tasks/loading.tsx`'s shape.
 *
 * The row counts descend so the placeholder reads as a grouped list rather than
 * as three identical panels; they are the same `[3, 2, 1]` the router-level
 * skeleton uses, deliberately, so the two are indistinguishable.
 */
export function TaskStatusGroupSkeleton({ groups = [3, 2, 1] }: { groups?: number[] }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {groups.map((rows, index) => (
        <div key={index} className="overflow-hidden rounded-lg border bg-card shadow-raised-lg">
          <div className="flex items-center gap-2 border-b bg-muted px-2 py-2">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-7 w-36 rounded-md" />
          </div>
          <div className="divide-y">
            {Array.from({ length: rows }, (_, row) => (
              <div key={row} className="flex items-center gap-4 px-3.5 py-3.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="hidden h-4 w-24 md:block" />
                <Skeleton className="ml-auto h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The board's columns — `app/(app)/tasks/board/loading.tsx`'s shape.
 *
 * ⚠️ A FRAGMENT, NOT A WRAPPER. These slot straight into the board's own
 * `flex … gap-3` scroller row, beside the pending-request column, so a wrapping
 * div would make the whole set one flex item and collapse the gaps.
 *
 * Descending card counts, so the placeholder reads as a board rather than as
 * six identical bars — and six of them, the same number the router-level
 * skeleton draws, so a navigation and an in-page stream look the same.
 */
export function BoardColumnSkeleton({ columns = 6 }: { columns?: number }) {
  return (
    <>
      {Array.from({ length: columns }, (_, index) => (
        <div
          key={index}
          aria-hidden
          // ⚠️ w-64 MATCHES `BoardColumn` in app/(app)/tasks/board/page.tsx.
          // It read w-72 and every one of the six columns jumped 32px left
          // when the real board arrived — the exact movement a skeleton is
          // for. Change one and change the other.
          className="flex h-full w-64 shrink-0 flex-col gap-2 rounded-lg border bg-muted p-2"
        >
          <Skeleton className="h-7 w-32 rounded-md" />
          {Array.from({ length: Math.max(1, 4 - index) }, (_, card) => (
            <Skeleton key={card} className="h-20 w-full rounded-md" />
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * P12-23 — the week grid, while its query is still `isPending`.
 *
 * ⚠️ SHARED WITH `app/(app)/timesheet/loading.tsx` RATHER THAN COPIED, and the
 * duplication it removes is the one the header of this file warns about. That
 * file renders while the route's (now trivial) server component runs; this
 * renders while the browser's query is in flight. Two shapes for one screen is
 * how a page visibly rearranges itself between two consecutive waits.
 *
 * ⚠️ IT STANDS IN FOR THE STATUS BAR AND THE GRID, NOT FOR THE WEEK NAVIGATION.
 * The arrows and the date range are derived from the URL and are rendered for
 * real by the server component, so they are on screen before this ever appears —
 * `loading.tsx` draws its own placeholder for them because at that moment even
 * the URL has not been read yet.
 */
export function WeekGridSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <>
      {/* `WeekStatusBar`: a status chip, a sentence, and the submit button. */}
      <div
        className="flex items-center gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg"
        aria-hidden>
        <Skeleton className="h-7 w-28 rounded-md" />
        <Skeleton className="h-4 flex-1" />
      </div>

      <div
        role="status"
        aria-busy="true"
        className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
        <span className="sr-only">Loading this week…</span>

        <div className="flex items-center gap-2 border-b px-3 py-2" aria-hidden>
          <Skeleton className="h-4 w-16" />
          <div className="ml-auto flex gap-2">
            {Array.from({ length: 7 }, (_, day) => (
              <Skeleton key={day} className="h-4 w-8" />
            ))}
          </div>
        </div>

        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-2 border-b px-3 py-2.5" aria-hidden>
            <Skeleton className="h-4 w-40" />
            <div className="ml-auto flex gap-2">
              {Array.from({ length: 7 }, (_, day) => (
                <Skeleton key={day} className="h-4 w-8" />
              ))}
            </div>
          </div>
        ))}

        <div className="px-3 py-2.5" aria-hidden>
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
    </>
  );
}

/**
 * P12-23 — the lead's week.
 *
 * A row per PERSON and a total column, which is the difference `team/loading.tsx`
 * exists to record: the personal grid's skeleton promised the wrong layout here
 * and the page rearranged itself the moment the data landed.
 */
export function TeamWeekGridSkeleton({ people = 6 }: { people?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
      <span className="sr-only">Loading the team&rsquo;s week…</span>

      <div className="flex items-center gap-2 border-b px-3 py-2" aria-hidden>
        <Skeleton className="h-4 w-28" />
        <div className="ml-auto flex gap-2">
          {Array.from({ length: 7 }, (_, day) => (
            <Skeleton key={day} className="h-4 w-9" />
          ))}
          <Skeleton className="h-4 w-12" />
        </div>
      </div>

      {Array.from({ length: people }, (_, person) => (
        <div
          key={person}
          className="flex items-center gap-2 border-b px-3 py-2.5 last:border-b-0"
          aria-hidden>
          <Skeleton className="h-4 w-36" />
          <div className="ml-auto flex gap-2">
            {Array.from({ length: 7 }, (_, day) => (
              <Skeleton key={day} className="h-4 w-9" />
            ))}
            <Skeleton className="h-4 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}

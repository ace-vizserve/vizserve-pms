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

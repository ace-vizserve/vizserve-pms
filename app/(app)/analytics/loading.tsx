import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The loaded page's shape — filters, four tiles, the per-department rings, the
 * per-person bars, the table — so nothing jumps when the data arrives.
 */
export default function Loading() {
  return (
    <PageShell aria-hidden>
      <div className="flex flex-wrap gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
        <Skeleton className="h-14 w-64" />
        <Skeleton className="h-14 w-40" />
        <Skeleton className="h-14 w-40" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, tile) => (
          <Skeleton key={tile} className="h-24 rounded-lg" />
        ))}
      </div>

      {/* The rings. Four is the lg column count — a plausible number of
          departments, and the grid reflows the same way the real one does. */}
      <div className="space-y-4 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg">
        <Skeleton className="h-4 w-56" />
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, ring) => (
            <div key={ring} className="flex flex-col items-center gap-2.5">
              <Skeleton className="size-28 rounded-full" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              {/* The reserved height of the hover panel, so the grid does not
                  jump when the real tiles arrive. */}
              <div className="min-h-24" />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg">
        <Skeleton className="h-4 w-52" />
        {Array.from({ length: 5 }, (_, bar) => (
          <div key={bar} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 rounded-full" />
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>

      <Skeleton className="h-48 rounded-lg" />
    </PageShell>
  );
}

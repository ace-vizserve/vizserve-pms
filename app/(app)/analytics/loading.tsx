import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The loaded page's shape — filter, four tiles, the per-person chart, the
 * table — so nothing jumps when the data arrives.
 */
export default function Loading() {
  return (
    <PageShell aria-hidden>
      <div className="flex gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
        <Skeleton className="h-14 w-64" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, tile) => (
          <Skeleton key={tile} className="h-24 rounded-lg" />
        ))}
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

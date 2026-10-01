import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The same shape the loaded page uses — range picker, four tiles, two chart
 * cards, then the table. A skeleton that does not match the page it stands in
 * for produces a layout jump on every load, which is worse than a spinner.
 */
export default function Loading() {
  return (
    <PageShell aria-hidden>
      <div className="flex gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
        <Skeleton className="h-14 w-40" />
        <Skeleton className="h-14 w-40" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, tile) => (
          <Skeleton key={tile} className="h-24 rounded-lg" />
        ))}
      </div>

      {Array.from({ length: 2 }, (_, card) => (
        <div
          key={card}
          className="space-y-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg"
        >
          <Skeleton className="h-4 w-52" />
          {Array.from({ length: 4 }, (_, bar) => (
            <div key={bar} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 rounded-full" />
              <Skeleton className="h-3 w-8" />
            </div>
          ))}
        </div>
      ))}

      <Skeleton className="h-48 rounded-lg" />
    </PageShell>
  );
}

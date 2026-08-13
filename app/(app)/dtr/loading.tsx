import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    // Mirrors the loaded page: punch panel and filters stacked in the rail, the
    // table taking the whole right column. A skeleton in the old shape would
    // just show the layout rearranging itself as the data lands.
    <PageShell className="gap-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-3" aria-hidden>
          <div className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-9 w-full" />
          </div>

          <div className="flex flex-col gap-2.5 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>

        <TableSkeleton columns={4} rows={8} />
      </div>
    </PageShell>
  );
}

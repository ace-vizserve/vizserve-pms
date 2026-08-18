import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A TABLE placeholder, matching the real inbox. It stood in for a hand-built
 * divided list until that list became a `DataTable` like every other list route
 * — and a skeleton that no longer resembles what arrives is worse than none,
 * because it promises one layout and delivers another.
 */
export default function Loading() {
  return (
    <PageShell>
      <div className="flex flex-wrap items-end gap-3" aria-hidden>
        <Skeleton className="h-10 w-full rounded-md sm:w-64 lg:w-72" />
        <Skeleton className="h-10 w-40 rounded-md" />
        <Skeleton className="h-10 w-32 rounded-md" />
        <Skeleton className="ml-auto h-10 w-32 rounded-md" />
      </div>

      <Skeleton className="-mt-1 h-3 w-20" aria-hidden />

      <TableSkeleton columns={3} rows={8} />
    </PageShell>
  );
}

import { PageShell } from "@/components/page-shell";
import { FilterBarSkeleton, TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <div className="flex justify-end gap-2" aria-hidden>
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-24" />
      </div>
      {/* The view tabs, which sit above the filters on this page only. */}
      <Skeleton className="h-10 w-full max-w-sm rounded-xl" aria-hidden />
      <FilterBarSkeleton fields={2} />
      <TableSkeleton columns={5} />
    </PageShell>
  );
}

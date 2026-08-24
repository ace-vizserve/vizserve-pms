import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <Skeleton className="h-3 w-96" aria-hidden />
      <div className="flex flex-wrap items-center gap-3" aria-hidden>
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="ml-auto h-7 w-28" />
      </div>
      <TableSkeleton columns={4} rows={8} />
    </PageShell>
  );
}

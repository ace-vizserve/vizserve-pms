import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <Skeleton className="h-3 w-96" aria-hidden />
      <div className="flex flex-wrap items-center gap-3" aria-hidden>
        <Skeleton className="h-9 w-full max-w-xs" />
        <Skeleton className="ml-auto h-7 w-24" />
      </div>
      <TableSkeleton columns={6} rows={8} />
    </PageShell>
  );
}

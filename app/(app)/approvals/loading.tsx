import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell className="gap-8">
      <div className="flex items-center justify-between gap-3" aria-hidden>
        <Skeleton className="h-3 w-80" />
        <Skeleton className="h-7 w-28" />
      </div>

      {/* One section, not two: the approver queue only renders when it has rows,
          and a skeleton for a section that may not exist is a layout jump. */}
      <div className="space-y-3">
        <div className="space-y-1.5" aria-hidden>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-48" />
        </div>
        <TableSkeleton columns={4} rows={5} />
      </div>
    </PageShell>
  );
}

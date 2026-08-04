import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <div className="flex justify-end" aria-hidden>
        <Skeleton className="h-7 w-24" />
      </div>
      <TableSkeleton columns={4} rows={5} />
    </PageShell>
  );
}

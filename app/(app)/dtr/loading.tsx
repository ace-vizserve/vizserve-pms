import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
        <div
          className="space-y-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10"
          aria-hidden
        >
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="space-y-4">
          <div
            className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:flex-row sm:items-end"
            aria-hidden
          >
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-40" />
          </div>
          <TableSkeleton columns={4} rows={8} />
        </div>
      </div>
    </PageShell>
  );
}

import { PageShell } from "@/components/page-shell";
import { StatRowSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-64" />
      </div>
      <StatRowSkeleton tiles={3} />
      <div
        className="max-w-md space-y-4 rounded-lg border bg-card grade-surface py-4 shadow-raised-lg"
        aria-hidden
      >
        <div className="space-y-2 px-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-52" />
        </div>
        <div className="px-4">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </PageShell>
  );
}

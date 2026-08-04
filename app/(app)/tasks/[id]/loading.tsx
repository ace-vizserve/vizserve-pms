import { PageShell } from "@/components/page-shell";
import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell className="mx-auto w-full max-w-4xl">
      <Skeleton className="h-3 w-20" aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-3" aria-hidden>
        <div className="space-y-2">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-3 w-44" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-36" />
        </div>
      </div>
      <CardSkeleton lines={3} />
      <CardSkeleton lines={5} />
      <CardSkeleton lines={2} />
    </PageShell>
  );
}

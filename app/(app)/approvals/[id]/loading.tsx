import { PageShell } from "@/components/page-shell";
import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      <Skeleton className="h-3 w-24" aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-3" aria-hidden>
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>
      <CardSkeleton lines={5} />
    </PageShell>
  );
}

import { PageShell } from "@/components/page-shell";
import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    // Mirrors the two-column grid the loaded page uses. A skeleton laid out
    // differently from what replaces it is worse than none — the content
    // visibly jumps into a different shape the moment it arrives.
    <PageShell className="gap-3">
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
      <div className="grid gap-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={5} />
          <CardSkeleton lines={2} />
        </div>
        {/* History, on its own — one card, and the tallest thing here. */}
        <div className="min-w-0">
          <CardSkeleton lines={6} />
        </div>
      </div>
    </PageShell>
  );
}

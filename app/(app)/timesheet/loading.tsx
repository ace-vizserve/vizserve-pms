import { PageShell } from "@/components/page-shell";
import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    // The same two-column shape the loaded page uses — rail left, week right.
    <PageShell className="gap-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-3" aria-hidden>
          <div className="flex flex-col gap-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
          <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <Skeleton className="h-8 w-32" />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="rounded-xl bg-card p-2 ring-1 ring-foreground/10" aria-hidden>
            <Skeleton className="mx-auto h-5 w-40" />
          </div>
          <CardSkeleton lines={3} />
          <CardSkeleton lines={2} />
        </div>
      </div>
    </PageShell>
  );
}

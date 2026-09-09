import { PageShell } from "@/components/page-shell";
import { WeekGridSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * ⚠️ THE GRID HALF IS SHARED WITH THE LOADED PAGE (`WeekGridSkeleton`), which is
 * the whole point of it being in `components/skeletons.tsx`. There are TWO waits
 * on this route now — this one while the server component runs, then the query's
 * own — and two hand-rolled shapes for one screen is how the page visibly
 * rearranges itself between them.
 *
 * The week navigation is the part that is NOT shared: `timesheet-view.tsx`
 * renders under a real one, built from the URL by the server component, and only
 * here has the URL not been read yet.
 */
export default function Loading() {
  return (
    <PageShell className="gap-3">
      <div className="rounded-lg border bg-card grade-surface p-2 shadow-raised-lg" aria-hidden>
        <Skeleton className="mx-auto h-5 w-40" />
      </div>

      <WeekGridSkeleton />
    </PageShell>
  );
}

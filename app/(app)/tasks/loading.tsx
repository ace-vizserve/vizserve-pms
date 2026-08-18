import { PageShell } from "@/components/page-shell";
import { FilterBarSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The list is grouped by stage now, so the skeleton is too. A flat table
 * placeholder followed by three stacked group panels is a layout jump, and the
 * jump is the only thing a skeleton exists to prevent.
 */
export default function Loading() {
  return (
    <PageShell>
      <div className="flex flex-wrap items-center gap-2" aria-hidden>
        <Skeleton className="h-9 w-40 rounded-lg" />
        <Skeleton className="h-9 w-64 rounded-lg" />
        <Skeleton className="ml-auto h-9 w-28 rounded-md" />
      </div>

      <FilterBarSkeleton fields={2} />

      <div className="flex flex-col gap-3" aria-hidden>
        {[3, 2, 1].map((rows, index) => (
          <div key={index} className="overflow-hidden rounded-lg border bg-card shadow-raised-lg">
            <div className="flex items-center gap-2 border-b bg-muted px-2 py-2">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-7 w-36 rounded-md" />
            </div>
            <div className="divide-y">
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} className="flex items-center gap-4 px-3.5 py-3.5">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="hidden h-4 w-24 md:block" />
                  <Skeleton className="ml-auto h-4 w-20" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/** The panel of rows, before it arrives. Same shape, so the page does not reflow. */
export default function Loading() {
  return (
    <PageShell>
      <div aria-hidden className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3.5">
              <Skeleton className="size-8 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-3 w-32 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

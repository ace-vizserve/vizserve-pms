import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Not `FilterBarSkeleton` — that one draws a bordered card, and the toolbar on
 * this page is a bare flex row. A skeleton in a different container than the
 * thing it stands in for is a layout shift on every load of the route.
 */
export default function Loading() {
  return (
    <PageShell>
      <Skeleton className="h-3 w-full max-w-3xl" aria-hidden />

      <div className="flex flex-wrap items-end gap-3" aria-hidden>
        {/* The search box and the three dropdowns, at their real widths. */}
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-10 w-full sm:w-64 lg:w-72" />
        </div>
        {[44, 52, 36].map((width) => (
          <div key={width} className="space-y-1.5">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-10" style={{ width: `${width * 4}px` }} />
          </div>
        ))}
      </div>

      <Skeleton className="h-3 w-40" aria-hidden />
      <TableSkeleton columns={6} rows={8} />
    </PageShell>
  );
}

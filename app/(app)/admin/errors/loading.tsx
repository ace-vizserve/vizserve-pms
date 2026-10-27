import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** The intro line, the chart beside the frequent list, the filters, the table. */
export default function Loading() {
  return (
    <PageShell>
      <Skeleton aria-hidden className="h-3 w-full max-w-3xl" />
      <Skeleton aria-hidden className="h-36 rounded-lg" />
      <div aria-hidden className="flex flex-wrap items-end gap-3">
        {[64, 36, 48, 40].map((width) => (
          <div className="space-y-1.5" key={width}>
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-10" style={{ width: `${width * 4}px` }} />
          </div>
        ))}
      </div>
      <TableSkeleton columns={7} rows={8} />
    </PageShell>
  );
}

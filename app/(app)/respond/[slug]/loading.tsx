import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The fill page, before it arrives — same measure and same shape as the real
 * one, so nothing reflows when the questions land.
 */
export default function Loading() {
  return (
    <PageShell className="max-w-3xl" aria-hidden>
      <Skeleton className="h-8 w-28" />

      <div className="space-y-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      <div className="space-y-6 rounded-lg border bg-card p-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
        <div className="flex justify-end border-t pt-4">
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
    </PageShell>
  );
}

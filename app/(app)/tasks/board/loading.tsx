import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The board's own skeleton. It mirrors the page's height contract — pinned to
 * the viewport and clipping — so the layout does not jump when the real columns
 * arrive, and a slow board never briefly widens the document on its way in.
 */
export default function Loading() {
  return (
    <PageShell className="h-[calc(100svh-3.5rem)] min-h-0 gap-3 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2" aria-hidden>
        <Skeleton className="h-9 w-40 rounded-lg" />
        <Skeleton className="h-9 w-64 rounded-lg" />
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden" aria-hidden>
        <div className="flex h-full items-stretch gap-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="flex h-full w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted p-2"
            >
              <Skeleton className="h-7 w-32 rounded-md" />
              {/* Descending card counts, so the placeholder reads as a board
                  rather than as six identical bars. */}
              {Array.from({ length: Math.max(1, 4 - index) }, (_, card) => (
                <Skeleton key={card} className="h-20 w-full rounded-md" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

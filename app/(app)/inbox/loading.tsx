import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageShell>
      <div className="flex items-center justify-between gap-4" aria-hidden>
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-28" />
      </div>

      {/* A list, not a table — mirroring the real divided card. */}
      <ul
        className="divide-y overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg"
        aria-hidden
      >
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className="flex items-start gap-3 p-4">
            <Skeleton className="mt-1.5 size-1.5 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-28" />
            </div>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}

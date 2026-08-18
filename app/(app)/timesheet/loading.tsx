import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    // The same shape the loaded page uses — week bar, then the grid.
    <PageShell className="gap-3" aria-hidden>
      <div className="rounded-xl bg-card p-2 ring-1 ring-foreground/10">
        <Skeleton className="mx-auto h-5 w-40" />
      </div>

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Skeleton className="h-4 w-16" />
          <div className="ml-auto flex gap-2">
            {Array.from({ length: 7 }, (_, day) => (
              <Skeleton key={day} className="h-4 w-8" />
            ))}
          </div>
        </div>

        {Array.from({ length: 4 }, (_, row) => (
          <div key={row} className="flex items-center gap-2 border-b px-3 py-2.5">
            <Skeleton className="h-4 w-40" />
            <div className="ml-auto flex gap-2">
              {Array.from({ length: 7 }, (_, day) => (
                <Skeleton key={day} className="h-4 w-8" />
              ))}
            </div>
          </div>
        ))}

        <div className="px-3 py-2.5">
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
    </PageShell>
  );
}

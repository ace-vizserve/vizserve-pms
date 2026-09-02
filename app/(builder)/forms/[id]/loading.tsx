import { Skeleton } from "@/components/ui/skeleton";

/**
 * The builder's three columns, before they arrive.
 *
 * It mirrors the real layout rather than showing a generic card stack: this
 * route is outside the app shell (`app/(builder)/layout.tsx`), so there is no
 * sidebar or breadcrumb still on screen to tell somebody where they are, and a
 * skeleton of a different shape would reflow the whole page the moment the data
 * lands.
 */
export default function Loading() {
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-3 border-b bg-panel px-5" aria-hidden>
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-4 w-48" />
      </div>

      {/* `min-h-0 flex-1`, matching the real panel: the shell is a fixed-height
          column that clips, so the skeleton has to sit inside the row rather
          than push the page past the window and give it a scrollbar the loaded
          page does not have. */}
      <div
        className="grid min-h-0 flex-1 items-start gap-4 overflow-y-auto p-5 xl:grid-cols-[15rem_minmax(0,1fr)_21rem]"
        aria-hidden
      >
        <div className="space-y-2 rounded-lg border bg-card p-3">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-11 w-full" />
          ))}
        </div>

        <div className="mx-auto w-full max-w-3xl space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>

        <div className="space-y-3 rounded-lg border bg-card p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    </>
  );
}

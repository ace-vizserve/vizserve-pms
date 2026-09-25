import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

import { TASK_DETAIL_GRID } from "./grid";

/**
 * P12-06 — the task detail placeholder, in ONE place.
 *
 * ⚠️ IT WAS THE BODY OF `loading.tsx` AND NOW HAS TWO CALLERS, which is the
 * whole reason it moved out. The route's `loading.tsx` still draws it while Next
 * resolves the segment; the client tree draws the SAME thing while `qk.task(id)`
 * is `isPending`, because the page no longer has its data by the time the
 * segment renders. Two hand-rolled copies of "the task page, in grey" is exactly
 * the drift `grid.ts` already exists to prevent, one layer up — its own header
 * makes the argument: a skeleton laid out differently from what replaces it is
 * worse than none, because the content visibly jumps the moment it arrives.
 *
 * Its own module rather than an export from `page.tsx` for the reason `grid.ts`
 * gives: importing from a page pulls the whole page module — every query, every
 * child component — into the boundary that exists to render before any of that
 * is ready.
 *
 * ⚠️ `aria-hidden` THROUGHOUT, and the caller supplies the announcement. In
 * `loading.tsx` the ROUTER announces the navigation; in the client tree the
 * wrapper is a `role="status"` region with a label. Twenty grey rectangles
 * enumerated one by one is not a loading message — see the note at the foot of
 * `components/skeletons.tsx`, which draws the same distinction.
 */
export function TaskDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-20" aria-hidden />

      {/* P7-57 — the title row: the name and its chip line on the left, the one
          promoted move on the right. The properties are no longer up here; they
          are the first card in the left column. */}
      <div className="flex flex-wrap items-start justify-between gap-4" aria-hidden>
        <div className="space-y-2">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      {/* The gate track, full width above both columns. Five stops on client
          work, and it is one short card rather than a stack. */}
      <Skeleton className="h-16 w-full rounded-lg" aria-hidden />

      <div className={TASK_DETAIL_GRID}>
        {/* Details — ten property rows, two pairs wide from `sm` — then The work:
            the brief, the request panel COLLAPSED so one line, the resolution,
            the output link and its files, and the subtasks. */}
        <div className="flex min-w-0 flex-col gap-3">
          <CardSkeleton lines={5} />
          <CardSkeleton lines={8} />
        </div>

        {/* The rail: Activity — the composer, then the feed — and the trail. */}
        <div className="flex min-w-0 flex-col gap-3">
          <CardSkeleton lines={5} />
          <CardSkeleton lines={6} />
        </div>
      </div>
    </>
  );
}

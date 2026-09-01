import { PageShell } from "@/components/page-shell";

import { TASK_DETAIL_GRID } from "./grid";
import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    // Mirrors the loaded page. A skeleton laid out differently from what
    // replaces it is worse than none — the content visibly jumps into a
    // different shape the moment it arrives.
    <PageShell className="gap-3">
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
    </PageShell>
  );
}

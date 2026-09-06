import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * ⚠️ THIS FILE EXISTS TO STOP A WRONG SKELETON, NOT TO ADD A MISSING ONE.
 *
 * `/timesheet/team` had no `loading.tsx` of its own, so it inherited
 * `app/(app)/timesheet/loading.tsx` — which draws the PERSONAL week grid: one
 * centred week label, a day-header row, and four single-person rows. The team
 * page is a different screen. It has a week-navigation card with arrows either
 * side of the range, and a grid of many PEOPLE against the seven days.
 *
 * So the fallback promised the wrong layout and then replaced it with something
 * else, which is the exact failure `components/skeletons.tsx` opens by warning
 * about: a skeleton that no longer matches its real layout is worse than none,
 * because the page visibly rearranges itself the moment the data lands.
 *
 * It matters more here than on most routes because this is one of the heaviest
 * screens in the app — ten queries, including every timesheet entry for the
 * whole team-week with a task embed, every DTR row for the week, and the leave
 * calendar — none of it paginated.
 *
 * The shape below mirrors `team-week-grid.tsx`: the nav card with an arrow at
 * each end, then a header row of seven days plus a total, then a row per
 * person. Six people is roughly a real department and is what the two existing
 * grid skeletons in this repo settled on.
 */
export default function Loading() {
  return (
    <PageShell className="gap-3" aria-hidden>
      {/* The week nav: chevron, range, chevron. Its real version needs no data
          at all — it is derived from the URL — so this is the one part of the
          page that could later render for real behind a Suspense boundary
          rather than as a skeleton. */}
      <div className="flex items-center justify-between rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="size-8 rounded-md" />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
        {/* Day headers, plus the total column the personal grid does not have. */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Skeleton className="h-4 w-28" />
          <div className="ml-auto flex gap-2">
            {Array.from({ length: 7 }, (_, day) => (
              <Skeleton key={day} className="h-4 w-9" />
            ))}
            <Skeleton className="h-4 w-12" />
          </div>
        </div>

        {/* A row per PERSON — the difference that made the inherited skeleton
            wrong. The leading bar is a name, so it is wider than the personal
            grid's task label. */}
        {Array.from({ length: 6 }, (_, person) => (
          <div key={person} className="flex items-center gap-2 border-b px-3 py-2.5 last:border-b-0">
            <Skeleton className="h-4 w-36" />
            <div className="ml-auto flex gap-2">
              {Array.from({ length: 7 }, (_, day) => (
                <Skeleton key={day} className="h-4 w-9" />
              ))}
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

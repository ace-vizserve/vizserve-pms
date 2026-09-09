import { PageShell } from "@/components/page-shell";
import { TeamWeekGridSkeleton } from "@/components/skeletons";
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
 * screens in the app — ten reads, including every timesheet entry for the whole
 * team-week with a task embed, every DTR row for the week, and the leave
 * calendar — none of it paginated.
 *
 * ⚠️ P12-23 — THE GRID HALF IS NOW SHARED WITH THE LOADED PAGE. There are TWO
 * waits on this route: this one while the server component resolves the week,
 * then `qk.teamWeekVisible(...)`'s own inside `team-view.tsx`. Both draw
 * `TeamWeekGridSkeleton`, so nothing moves between them. The week NAVIGATION is
 * the part that is not shared — the real one is built from the URL by the server
 * component, and only here has the URL not been read yet.
 */
export default function Loading() {
  return (
    <PageShell className="gap-3" aria-hidden>
      {/* The week nav: chevron, range, chevron. Its real version needs no data
          at all — it is derived from the URL — which is why it renders for real
          the moment the server component has run. */}
      <div className="flex items-center justify-between rounded-lg border bg-card grade-surface p-2 shadow-raised-lg">
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="size-8 rounded-md" />
      </div>

      <TeamWeekGridSkeleton />
    </PageShell>
  );
}

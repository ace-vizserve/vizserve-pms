"use client";

import { useQuery } from "@tanstack/react-query";

import ContributionSkyline from "@/components/ui/contribution-skyline";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDtrYear } from "@/lib/query/fetchers/dtr";
import { qk } from "@/lib/query/keys";

/**
 * A year of one person's DTR as a flat heat map above the table — hours worked
 * per day, leave in amber. Its own key, so it neither waits for the table nor
 * refetches when the range or sort changes; it follows the person filter only.
 *
 * The 3D skyline view is switched off (`showToggle={false}`).
 */
export function DtrYear({ userId, name }: { userId: string; name: string | null }) {
  const year = useQuery({
    queryKey: qk.dtrYear(userId),
    queryFn: () => fetchDtrYear(browserClient(), userId),
  });

  if (year.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="space-y-3 rounded-xl border bg-card grade-surface p-4 shadow-raised-lg">
        <span className="sr-only">Loading the year…</span>
        <Skeleton className="h-4 w-40" aria-hidden />
        <Skeleton className="h-32 w-full" aria-hidden />
      </div>
    );
  }

  if (year.isError) {
    return <QueryError what="the year of punches" message={year.error.message} />;
  }

  return (
    <ContributionSkyline
      data={year.data.days}
      endDate={year.data.today}
      restDays={year.data.restDays}
      leaveDays={year.data.leaveDays}
      defaultView="2d"
      showToggle={false}
      orbit={false}
      palette="ocean"
      unit="hour"
      weekStart={1}
      title={
        <>
          <span className="font-semibold">{name ? `${name}'s DTR` : "Your DTR"}</span>
          <span className="text-muted-foreground"> · the last year</span>
        </>
      }
      className="shrink-0 grade-surface shadow-raised-lg"
    />
  );
}

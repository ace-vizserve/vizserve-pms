"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { formatDate } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import { TASK_STATUS_LABELS, type TaskStatus } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

/**
 * P15-10 — every copy of a recurring task, newest first: the history a series
 * exists to keep. Each copy is its own task with its own time, so this is a
 * list of links, not a merged view.
 *
 * Policy-scoped like every task read: a copy the viewer cannot see is absent.
 */
export function SeriesCopies({ seriesId, currentTaskId }: { seriesId: string; currentTaskId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["task-series-copies", seriesId],
    queryFn: async () => {
      const { data, error } = await browserClient()
        .from("vizserve_pms_tasks")
        .select("id, title, status, series_period_start")
        .eq("series_id", seriesId)
        .order("series_period_start", { ascending: false })
        .limit(12);
      if (error) throw error;
      return data as { id: string; title: string; status: TaskStatus; series_period_start: string | null }[];
    },
  });

  if (isPending) return <span className="text-2xs text-muted-foreground">Loading copies…</span>;
  if (isError) return <span className="text-2xs text-destructive">Could not load the earlier copies.</span>;
  if (!data || data.length <= 1) return null;

  return (
    <details className="w-full">
      <summary className="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">
        {data.length >= 12 ? "Latest 12 copies" : `${data.length} copies`} of this task
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {data.map((copy) => (
          <li key={copy.id} className="flex items-center gap-2 text-2xs">
            <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
              {copy.series_period_start ? formatDate(copy.series_period_start) : "—"}
            </span>
            {copy.id === currentTaskId ? (
              <span className="font-medium">This copy</span>
            ) : (
              <Link href={`/tasks/${copy.id}`} className="hover:underline">
                Open
              </Link>
            )}
            <span className={cn("ml-auto", copy.status === "COMPLETED" ? "text-success" : "text-muted-foreground")}>
              {TASK_STATUS_LABELS[copy.status]}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

"use client";

import { TriangleAlert } from "lucide-react";

import { formatDate } from "@/lib/dates";
import { STAGE_SAMPLE_LIMIT, type StageSample } from "@/lib/department-analytics";
import { cn } from "@/lib/utils";

/**
 * P11-14 — WHICH TASKS ARE IN THIS BAND. The body of every hover panel on
 * /analytics: the ring's, and the per-person bar's.
 *
 * One component rather than two, because the two panels answer the identical
 * question and differ only in what they are drawn on — the ring's sits on a
 * card, the bar's inside an inverted tooltip. `inverted` is that difference and
 * the only prop about looks.
 *
 * ⚠️ OVERDUE IS MARKED BY THE WORD, NOT BY THE COLOUR. On the card the red is
 * `--chart-overdue`, which is measured against a card; on the tooltip's near
 * black there is no red in this system with the contrast to sit on it, so the
 * inverted copy leans on the icon and the word "Overdue" alone. Both carry the
 * word either way — the house rule is that state is never colour alone, so
 * dropping the colour costs nothing and dropping the word would not have been
 * allowed.
 */
export function StageSampleList({
  samples,
  /** The band's FULL count, which the sample is usually smaller than. */
  count,
  inverted = false,
}: {
  samples: StageSample[];
  count: number;
  inverted?: boolean;
}) {
  return (
    <>
      <ul className="space-y-1">
        {samples.map((sample) => (
          <li key={sample.id} className="min-w-0">
            <span className="block truncate text-2xs" title={sample.title}>
              {sample.title}
            </span>
            <span
              className={cn(
                "flex items-center gap-1 text-2xs",
                sample.overdue && !inverted && "font-medium text-chart-overdue",
                sample.overdue && inverted && "font-medium",
                !sample.overdue && (inverted ? "opacity-70" : "text-muted-foreground"),
              )}
            >
              {sample.overdue ? <TriangleAlert className="size-2.5 shrink-0" aria-hidden /> : null}
              {sample.dueDate
                ? `${sample.overdue ? "Overdue — was due" : "Due"} ${formatDate(sample.dueDate)}`
                : "No due date"}
            </span>
          </li>
        ))}
      </ul>

      {/* The sample is capped; the count is not. Say so, or four titles out of
          sixty reads as all of them. */}
      {count > STAGE_SAMPLE_LIMIT ? (
        <p className={cn("text-2xs", inverted ? "opacity-70" : "text-muted-foreground")}>
          and {count - STAGE_SAMPLE_LIMIT} more
        </p>
      ) : null}
    </>
  );
}

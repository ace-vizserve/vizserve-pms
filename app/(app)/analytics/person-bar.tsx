"use client";

import type { StageKey, StageSamples } from "@/lib/department-analytics";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { STAGES } from "./stages";
import { StageSampleList } from "./stage-sample-list";

/**
 * P11-14 — ONE PERSON'S BAR, WITH A HOVER LAYER. The /analytics counterpart of
 * `charts.tsx`'s `StageBar`, which stays exactly as it is for /reports.
 *
 * TWO COMPONENTS RATHER THAN A FLAG ON ONE, and the seam is the RSC boundary
 * rather than taste. `StageBar` renders on the server and ships no JavaScript,
 * which is the right trade for /reports, where there is nothing to reveal — its
 * every figure is already on the bar. This one has a question to answer that the
 * marks cannot ("which tasks are those 25?"), so it pays for a client component,
 * and a shared component with an `interactive` prop would have dragged /reports
 * across that boundary for a feature it does not use. The three stage colours
 * come from `stages.ts`, so neither copy can drift on the thing that matters.
 *
 * ⚠️ A FLOATING TOOLTIP HERE, WHERE THE RING USES AN IN-FLOW PANEL. A bar is a
 * full-width row in a stack of them: an in-flow panel would either push every
 * row below it down as the pointer moves, or reserve six rems of empty space on
 * each of twenty rows. The ring's tile has somewhere to put it and a bar does
 * not. The Base UI tooltip also brings the focus, Escape and ARIA behaviour that
 * a hand-rolled popup would have to re-earn.
 *
 * ⚠️ EACH SEGMENT IS THE TRIGGER, so hovering the green answers "which are
 * done" rather than the whole row answering "which are anything". They are real
 * buttons — that is what `TooltipTrigger` renders — so the bands are reachable
 * by keyboard, which a hoverable `<div>` never is.
 */
export function PersonBar({
  name,
  counts,
  samples,
}: {
  name: string;
  counts: Record<StageKey, number>;
  samples: StageSamples;
}) {
  const total = counts.notStarted + counts.active + counts.completed;

  return (
    <div className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3">
      <span className="min-w-0 truncate text-xs font-medium" title={name}>
        {name}
      </span>

      {total === 0 ? (
        <span className="text-2xs text-muted-foreground">No tasks in this period</span>
      ) : (
        // gap-0.5 is the 2px surface gap between adjacent fills. Without it two
        // segments of similar lightness read as one bar.
        //
        // ⚠️ NO `overflow-hidden`, unlike `StageBar`. The bands are focusable
        // here, and a clipped focus ring is an invisible one — the rounding is
        // on the first and last band instead, which the server version could
        // afford to do the lazy way because nothing in it ever takes focus.
        <div className="flex h-2.5 min-w-0 gap-0.5 rounded-full">
          {STAGES.map((stage) => {
            const value = counts[stage.key];
            if (value === 0) return null;

            return (
              <Tooltip key={stage.key}>
                <TooltipTrigger
                  className={cn(
                    stage.fill,
                    "h-full min-w-0 first:rounded-l-full last:rounded-r-full",
                    // The band is the hit target and it is 10px tall, so the
                    // focus ring is pulled in tight rather than at the global
                    // 2px offset, where it would swallow the neighbouring band.
                    "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                  )}
                  style={{ width: `${(value / total) * 100}%` }}
                  // The whole sentence: a 4px-wide band has no shape to read, so
                  // a screen reader gets what the bar and the legend say together.
                  aria-label={`${stage.label}: ${value} of ${total} tasks — ${name}`}
                />
                <TooltipContent
                  // The default popup is a one-line label: centred, and sized
                  // for a few words. This one holds a list.
                  className="w-64 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-1 px-3 py-2 text-left"
                >
                  <p className="text-2xs font-medium">
                    {stage.label}
                    <span className="ml-1 font-normal tabular-nums opacity-70">{value}</span>
                  </p>
                  <StageSampleList samples={samples[stage.key]} count={value} inverted />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      <span className="shrink-0 text-xs font-medium tabular-nums">{total}</span>
    </div>
  );
}

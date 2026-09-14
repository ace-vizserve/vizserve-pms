"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import type { StageKey, StageSamples } from "@/lib/department-analytics";
import { cn } from "@/lib/utils";

import { STAGES, STAGE_STROKE } from "./stages";
import { StageSampleList } from "./stage-sample-list";

/**
 * P11-14 — ONE SUBJECT'S STAGE SPLIT AS A RING, for the small multiples on
 * /analytics. Plain SVG, no charting library — the same call `charts.tsx` makes
 * for the bars, and the arithmetic is four lines.
 *
 * A SUBJECT IS A DEPARTMENT OR A PERSON, and the component does not care which.
 * /analytics draws one ring per department while the filter is on "all", and
 * one per team member once a department is picked — because at that point the
 * lead has stopped asking "which team" and started asking "who". Same marks,
 * same colours, same hover panel; only the caption above the grid changes.
 *
 * ⚠️ PER-PERSON RINGS DO NOT ADD UP TO THE DEPARTMENT'S, and the card above
 * them says so. Everybody on a shared task counts it, so one task lands in
 * three people's rings — the same reason the per-person bars carry that
 * warning. The per-department rings DO add up, because a task is filed in
 * exactly one department.
 *
 * A CLIENT COMPONENT, unlike every other chart in this app, and only because of
 * the hover layer. The dataviz method's default is that an HTML chart IS
 * interactive; the bars opt out because every figure on them is already on
 * screen, and this one opts in because hovering a slice answers a question the
 * marks cannot: not how many tasks are in progress, but WHICH.
 *
 * ⚠️ THE RING IS THREE SLICES AND OVERDUE IS NOT ONE OF THEM, for two separate
 * reasons and either would be enough.
 *
 *   IT WOULD BE UNREADABLE. Seated as a fourth series beside the orange, the
 *   overdue red measures ΔE 7.7 for NORMAL colour vision on the dark surface —
 *   two stages a full-colour reader cannot tell apart, which is a broken chart
 *   rather than a colour-blindness edge case. The numbers are on the tokens.
 *
 *   IT WOULD DOUBLE-COUNT. An overdue task is still not-started or in-progress,
 *   so it is already inside the ring. A fourth slice would add it twice and the
 *   ring would stop being a part-to-whole at all.
 *
 * So overdue is a FIGURE under the ring, in `--chart-overdue`, with the word
 * "overdue" and an icon on it — which is how the design system says a status
 * colour ships, and it is the same red the table's "late" column already uses.
 *
 * ⚠️ EVERY SLICE CARRIES ITS LABEL AND ITS NUMBER in the list beneath the ring,
 * with no hover needed. That is not decoration — it is what makes the chart
 * survive greyscale, a printout, and the validator's protan WARN on the
 * green↔orange pair, and it is the house rule ("state is never conveyed by
 * colour alone") applied to a chart rather than to a status chip. The hover
 * panel adds detail; it is never the only way to read a figure.
 */

/*
 * r = 15.9155 makes the circumference exactly 100, so a dash length IS a
 * percentage and none of the arithmetic below needs a circumference constant.
 */
const RADIUS = 15.9155;

/** A department or a person — whatever the ring is about. */
export type DonutSubject = {
  id: string;
  name: string;
  notStarted: number;
  active: number;
  completed: number;
  overdue: number;
  samples: StageSamples;
};

export function StageDonut({ subject }: { subject: DonutSubject }) {
  // Which slice the pointer or keyboard focus is on. One piece of state; the
  // ring's centre and the panel below it both read it.
  const [open, setOpen] = useState<StageKey | null>(null);

  const counts: Record<StageKey, number> = {
    notStarted: subject.notStarted,
    active: subject.active,
    completed: subject.completed,
  };
  const total = counts.notStarted + counts.active + counts.completed;

  // The 2px surface gap the mark spec asks for between adjacent fills — it stops
  // two slices reading as one arc. Dropped when a single stage holds everything,
  // or the ring would be drawn with a nick out of it for no reason.
  const drawn = STAGES.filter((stage) => counts[stage.key] > 0);
  const gap = drawn.length > 1 ? 1.5 : 0;

  const shown = open ? STAGES.find((stage) => stage.key === open) : null;

  /*
   * The arcs, laid out in one pass BEFORE the JSX rather than with a cursor
   * mutated inside it — the React Compiler rejects a variable reassigned during
   * render, and it is right to: a memoised re-render could pick the loop up
   * mid-way and draw the slices on top of each other.
   *
   * `offset` is where the arc starts, as a percentage clockwise from twelve
   * o'clock; `length` is how far it runs, less the gap that separates it from
   * the next one. Floored, because a 0.4% slice would otherwise disappear into
   * its own gap and read as a stage with nothing in it.
   */
  const arcs = STAGES.reduce<
    {
      key: StageKey;
      offset: number;
      length: number;
      /**
       * What this slice takes off the ring, its gap included — which is where
       * the next one starts, and is NOT the same as the length it draws.
       */
      consumed: number;
    }[]
  >((drawnArcs, stage) => {
    const value = counts[stage.key];
    if (total === 0 || value === 0) return drawnArcs;

    const previous = drawnArcs.at(-1);
    const offset = previous ? previous.offset + previous.consumed : 0;
    const percent = (value / total) * 100;

    return [
      ...drawnArcs,
      {
        key: stage.key,
        offset,
        length: Math.max(percent - gap, 0.75),
        consumed: percent,
      },
    ];
  }, []);

  return (
    <div
      className="flex flex-col items-center gap-2.5"
      // Leaving the tile closes the panel. Without this a slice keeps its
      // highlight when the pointer exits through the gap between two arcs.
      onMouseLeave={() => setOpen(null)}
    >
      <div className="relative size-28">
        <svg viewBox="0 0 42 42" className="size-full -rotate-90">
          {/* The track is a place, not a value — it gives the ring a shape while
              a department is empty, and backs the gaps while it is not. */}
          <circle cx="21" cy="21" r={RADIUS} fill="none" className="stroke-track" strokeWidth="5" />

          {arcs.map((arc) => {
            const stage = STAGES.find((candidate) => candidate.key === arc.key)!;
            const value = counts[arc.key];
            const isOpen = open === arc.key;

            return (
              <circle
                key={stage.key}
                cx="21"
                cy="21"
                r={RADIUS}
                fill="none"
                className={cn(
                  STAGE_STROKE[arc.key],
                  // Only the drawn arc is a hit target. The default would make
                  // the circle's whole disc hoverable and all three slices would
                  // fight over the same pixels.
                  "[pointer-events:stroke] transition-[stroke-width,opacity] duration-150",
                  // The global focus ring is drawn outside the element, so on an
                  // SVG arc it would trace the bounding box rather than the
                  // slice. The slice thickens instead, and keyboard and pointer
                  // get the SAME cue — which is what makes it a legible one.
                  "outline-none",
                  isOpen ? "[stroke-width:7]" : "[stroke-width:5]",
                  // The other slices recede rather than this one shouting: the
                  // reader is choosing among three, not being alerted to one.
                  open && !isOpen && "opacity-40",
                )}
                strokeDasharray={`${arc.length} ${100 - arc.length}`}
                strokeDashoffset={-arc.offset}
                tabIndex={0}
                role="button"
                // The whole sentence, because a slice cannot be read by shape:
                // a screen reader gets what a sighted reader assembles from the
                // ring and the list under it.
                aria-label={`${stage.label}: ${value} of ${total} tasks — ${subject.name}`}
                onMouseEnter={() => setOpen(stage.key)}
                onFocus={() => setOpen(stage.key)}
                onBlur={() => setOpen(null)}
                // Tapping is the touch equivalent of hovering — without this the
                // panel is unreachable on a phone, where there is no hover at
                // all. Escape closes it, as it does for every overlay here.
                onClick={() => setOpen(isOpen ? null : stage.key)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOpen(null);
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setOpen(isOpen ? null : stage.key);
                  }
                }}
              />
            );
          })}
        </svg>

        {/* The hole, doing work: the department's total sits in it, and swaps to
            the hovered stage's own count rather than a second number appearing
            somewhere else on the tile. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-3 text-center">
          <span className="text-lg font-semibold leading-none tabular-nums">
            {shown ? counts[shown.key] : total}
          </span>
          <span className="mt-0.5 line-clamp-2 text-2xs leading-tight text-muted-foreground">
            {shown ? shown.label.toLowerCase() : total === 1 ? "task" : "tasks"}
          </span>
        </div>
      </div>

      <p className="w-full truncate text-center text-xs font-medium" title={subject.name}>
        {subject.name}
      </p>

      {total === 0 ? (
        <p className="text-2xs text-muted-foreground">No tasks here</p>
      ) : (
        <>
          {/* The direct labels. Always present, hover or no hover. */}
          <dl className="w-full space-y-1">
            {STAGES.map((stage) => (
              <div
                key={stage.key}
                className={cn(
                  "flex items-center gap-1.5 text-2xs transition-opacity duration-150",
                  open && open !== stage.key && "opacity-40",
                )}
              >
                <span className={cn("size-2 shrink-0 rounded-sm", stage.fill)} aria-hidden />
                <dt className="min-w-0 flex-1 truncate text-muted-foreground">{stage.label}</dt>
                <dd className="shrink-0 font-medium tabular-nums">{counts[stage.key]}</dd>
              </div>
            ))}
          </dl>

          {/*
            * OVERDUE, IN RED, WITH THE WORD ON IT — a figure rather than a
            * slice, for the two reasons in the header. Rendered only when there
            * is something to say: a permanent "0 overdue" on every tile trains
            * the reader to stop looking at the one line that matters.
            */}
          {subject.overdue > 0 ? (
            <p className="flex w-full items-center gap-1.5 text-2xs font-medium text-chart-overdue">
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              {subject.overdue} overdue
            </p>
          ) : null}
        </>
      )}

      {/*
        * THE HOVER PANEL, IN NORMAL FLOW RATHER THAN IN A FLOATING TOOLTIP.
        *
        * It is up to four titles with their dates, which is a paragraph rather
        * than a label. A tooltip that size has to be dodged to read the chart
        * behind it, and at 390px it would be wider than the tile it belongs to.
        * In flow it cannot overflow the viewport, and it sits in the DOM beside
        * the ring it describes rather than in a portal at the end of the body.
        *
        * ⚠️ THE HEIGHT IS RESERVED, NOT GROWN. Without the min-height the whole
        * grid of tiles reflows the instant a slice is hovered — and the slice
        * moves out from under the pointer that is hovering it.
        */}
      <div className="min-h-24 w-full" aria-live="polite">
        {shown && counts[shown.key] > 0 ? (
          <div className="space-y-1 rounded-md border bg-muted/50 p-2">
            <p className="text-2xs font-medium">
              {shown.label}
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                {counts[shown.key]}
              </span>
            </p>

            <StageSampleList samples={subject.samples[shown.key]} count={counts[shown.key]} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

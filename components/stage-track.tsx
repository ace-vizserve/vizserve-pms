import { Check, Circle, CircleAlert, CircleDot } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * A progress rail: fixed stops, in order, with one of them live.
 *
 * ⚠️ EXTRACTED FROM `app/(app)/tasks/[id]/lifecycle-rail.tsx` (P7-28 / P7-57)
 * WITHOUT CHANGING A PIXEL. It was the only stepper in the app, and it was
 * shaped around the three task gates — `buildSteps` there names the task
 * categories, imports `TaskStatus`, and knows what a client decision is. None of
 * that is in here. What is in here is the part every rail needs: four marker
 * states, the connectors, and one line of `meta` under each label.
 *
 * ⚠️ THE `meta` SLOT IS WHY THIS MOVED. The internal approval chain (P9-04) drew
 * its own rail by hand and could only manage a role and an adverb —
 * "Team leader · Done" — with no room for who, when or why. This component had
 * that slot already and nothing else did, so the choice was to copy it or to
 * share it.
 *
 * ⚠️ NOTHING HERE DECIDES WHAT THE STAGES ARE. A caller builds `Step[]` and this
 * draws it. That is the seam: a rail that invented its own stages could invent
 * one a request does not have, which is the exact failure the task version warns
 * about in its own header — a greyed-out Gate 3 on internal work reports closed
 * work as unfinished, for ever.
 */

export type StepState = "done" | "current" | "pending" | "attention";

export type Step = {
  label: string;
  state: StepState;
  /** Date, person, or what the client said. One short line. */
  meta?: string | null;
};

const MARKER: Record<
  StepState,
  { icon: LucideIcon; className: string; word: string; pulse?: string }
> = {
  // Shape as well as colour, in all four: greyscale has to separate them (§5.5),
  // and a tick, a filled dot, an empty ring and an alert do.
  //
  // `pulse` is the FOURTH carrier and it is only ever on the LIVE stage — the
  // one place on the page where something is still moving. It is decoration
  // over three carriers that already work without it, and the utility itself
  // sits behind `prefers-reduced-motion`, so it can vanish entirely and the
  // track still reads. Its tint is named per state: a brand-blue halo on
  // `attention` would report a client asking for changes in the same colour as
  // ordinary progress.
  // A FILLED green disc, not an outline tick. The outline read as a hairline
  // at 16px and a passed gate has to be obvious from across the header.
  // A RAISED green chip, not an outline tick and not a flat disc. Depth is
  // outward (§1.5): its own fill, the `grade-chip` wash for a lit top edge and
  // `shadow-raised` under it, so a passed gate sits ON the header rather than
  // being painted onto it — and reads as green from across the page, which a
  // 1px outline at 16px did not.
  done: {
    icon: Check,
    className: "border border-success bg-success grade-chip text-background shadow-raised",
    word: "done",
  },
  current: {
    icon: CircleDot,
    className: "text-primary",
    word: "now",
    pulse: "pulse-now",
  },
  pending: {
    icon: Circle,
    className: "text-foreground-faint",
    word: "still to come",
  },
  attention: {
    icon: CircleAlert,
    className: "text-warning",
    word: "needs attention",
    pulse: "pulse-now [--pulse-tint:var(--warning)]",
  },
};


/**
 * The rail itself.
 *
 * Horizontal from `sm` up, vertical below it: five stops with two lines of meta
 * each cannot sit side by side in 390px without truncating the labels or
 * scrolling the page sideways, and §9 forbids the second.
 */
export function StageTrack({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    /*
      HORIZONTAL, ACROSS THE TOP, AND ABOVE BOTH COLUMNS.

      It used to be a vertical rail stacked on top of the history trail inside
      one card, and the two are different questions drawn as one object: this is
      a ROUTE with fixed stops, ordered by the pipeline, and the trail under it
      is a LOG ordered by time, newest first. A pipeline sitting directly above a
      reverse-chronological list made the first look like the beginning of the
      second.

      It is up here because "how far along is this" is a header fact — it belongs
      beside the status chip and the button that moves it, not three cards down
      the right-hand rail.

      Vertical again below `sm`: five stops with two lines of meta each cannot be
      laid side by side in 390px without either truncating the labels or scrolling
      the page sideways, and §9 forbids the second.
    */
    <ol
      className={cn(
        "flex flex-col gap-2.5 p-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-y-3",
        className,
      )}
    >
      {steps.map((step, index) => {
        const marker = MARKER[step.state];
        const Icon = marker.icon;

        return (
          <li
            key={step.label}
            className={cn(
              "flex min-w-0 items-start gap-2.5",
              // Only the connectors stretch, so the free width falls BETWEEN
              // stops rather than being shared out inside their labels.
              index === 0 ? "sm:flex-none" : "sm:flex-1",
            )}>
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "mt-[9px] hidden h-0.5 min-w-4 flex-1 rounded-full sm:block",
                  // Filled only where the work has actually passed.
                  step.state === "done" || steps[index - 1].state === "done"
                    ? "bg-success"
                    : "bg-border",
                )}
              />
            ) : null}

            {/* The halo needs a box to ring, and an icon glyph is not one —
                the ring inherits this span's radius and size, so it stays
                circular against a circular marker at any type scale. */}
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                marker.className,
                marker.pulse,
              )}>
              <Icon className={cn(step.state === "done" ? "size-2.5" : "size-4")} aria-hidden />
            </span>

            <div className="min-w-0">
              <p
                className={cn(
                  "text-xs leading-tight font-semibold",
                  step.state === "pending" ? "font-medium text-muted-foreground" : null,
                )}>
                {step.label}
                {/* The marker is a colour and a shape; this is the word. */}
                <span className="sr-only"> — {marker.word}</span>
              </p>
              {step.meta ? (
                <p className="text-2xs wrap-break-word text-muted-foreground">{step.meta}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * `19 Aug · Maria Santos`, dropping whichever half is missing.
 *
 * The dropping is the useful part: a stage that has been reached but whose
 * approver's name this reader may not see still dates itself, and a name with no
 * timestamp still says who. Neither case renders a stray separator.
 */
export function metaLine(
  ...parts: Array<string | null | undefined>
): string | null {
  const kept = parts.filter(Boolean);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** A timestamp for `metaLine`, formatted the way every other date on a page is. */
export function metaDate(when: string | null | undefined): string | null {
  return when ? formatDate(when.slice(0, 10)) : null;
}

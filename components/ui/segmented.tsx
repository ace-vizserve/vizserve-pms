"use client";

import * as React from "react";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";

import { cn } from "@/lib/utils";

/**
 * A segmented control — pick exactly one of a small, visible set.
 *
 * ELEVATION IS THE WHOLE AFFORDANCE. The track is FLAT, because it is a place
 * rather than a control; the selected segment is the only lifted thing in the
 * group, and that lift is what marks it. No inset, no carved groove — depth in
 * this system is outward only.
 *
 * SELECTION IS EXPRESSED AS `data-checked`, NOT AS A SECOND CLASS STRING, and
 * that is load-bearing. `app/(app)/tasks/toolbar.tsx` builds the same control
 * out of `<Link>`s — its segments navigate, so they cannot be radio buttons
 * without lying about what they do — and a link can carry `data-checked` just
 * as well as a radio can. One string dresses both. Every other pair of style
 * maps in this repo that was written twice has drifted.
 *
 * Padding is deliberately absent: a labelled segment wants `px-2.5 py-1`, an
 * icon-only one wants a square. The caller decides.
 */
export const segmentedTrack =
  "inline-flex shrink-0 items-center gap-1 rounded-lg border bg-muted p-1";

export const segmentedItem = cn(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm",
  "border border-transparent text-xs font-[550] whitespace-nowrap",
  "text-muted-foreground transition-all hover:text-foreground",
  // The thumb. `grade-raised` layers OVER `bg-card`, never instead of it — the
  // grade utilities are not in the `bg-` namespace precisely so tailwind-merge
  // keeps both instead of eating the colour.
  "data-checked:border-border data-checked:bg-card data-checked:grade-raised",
  "data-checked:text-foreground data-checked:shadow-raised",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
);

/**
 * `RadioGroup` rather than a toggle group: exactly one option is always chosen,
 * which is what a radio group means and what a screen reader announces. It also
 * brings the arrow-key roving focus that a row of buttons would otherwise have
 * to reimplement.
 */
function Segmented<Value extends string>({ className, ...props }: RadioGroup.Props<Value>) {
  return <RadioGroup data-slot="segmented" className={cn(segmentedTrack, className)} {...props} />;
}

/**
 * One segment. Base UI's `Radio.Root` carries `role="radio"`, `aria-checked`
 * and the hidden input — so an icon-only segment still needs its own
 * `aria-label`, like every other icon-only control in this system.
 */
function SegmentedItem({ className, ...props }: React.ComponentProps<typeof Radio.Root>) {
  return <Radio.Root data-slot="segmented-item" className={cn(segmentedItem, className)} {...props} />;
}

export { Segmented, SegmentedItem };

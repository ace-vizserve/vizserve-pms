"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A set of disclosures with one heading each.
 *
 * ⚠️ BASE UI, NOT RADIX — §2.1. The pattern this was adapted from imports
 * `@radix-ui/react-accordion` and composes with `asChild`; neither exists in
 * this app. `components.json` is `"style": "base-nova"`, every other primitive
 * in this folder wraps `@base-ui/react`, and a second headless library for one
 * component means two focus-management implementations, two sets of `data-*`
 * attributes and two keyboard models on one screen.
 *
 * ⚠️ AND IT IS NOT `collapsible.tsx`. That one is a single disclosure with no
 * notion of siblings. An accordion is the SET — arrow keys move between the
 * headers, `multiple` decides whether opening one closes the last, and the
 * value is a list. Several `Collapsible`s in a div gets the look and none of
 * that.
 *
 * `multiple` defaults to FALSE upstream, which is the accordion's own
 * convention and is left alone: a call site that wants several panels open at
 * once says so, in a word, where that decision is visible.
 */
function Accordion<Value = string>({ className, ...props }: AccordionPrimitive.Root.Props<Value>) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("w-full", className)}
      {...props}
    />
  );
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  );
}

/**
 * The header and its button, together — a trigger is never rendered bare.
 *
 * The chevron ships INSIDE it rather than at the call site, for the reason §7
 * gives about duplicated maps: three screens each drawing their own disclosure
 * arrow is three chances for one of them to point the wrong way.
 *
 * ⚠️ `data-panel-open` IS BASE UI'S ATTRIBUTE. Radix's is `data-state=open`,
 * which is why a pasted `[&[data-state=open]>svg]:rotate-180` selector compiles
 * here, matches nothing, and leaves the arrow pointing down on an open panel.
 */
function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header data-slot="accordion-header" className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger flex flex-1 items-center justify-between gap-3 rounded-md py-4 text-left text-sm font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open/accordion-trigger:rotate-180 motion-reduce:transition-none"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

/**
 * ⚠️ THE HEIGHT COMES FROM A CSS VARIABLE, AND THAT IS THE WHOLE TRICK. Base UI
 * measures the panel and publishes `--accordion-panel-height`; the element
 * transitions to it, and back to `0` under `data-starting-style` /
 * `data-ending-style`. There is no `animate-accordion-down` keyframe in this
 * project and there must not be one — a keyframe with a fixed height cannot
 * know how tall a panel is, so it animates to the wrong height for every panel
 * that is not the length its author happened to have.
 *
 * `motion-reduce:transition-none` per §1.7: the panel still opens, instantly.
 */
function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };

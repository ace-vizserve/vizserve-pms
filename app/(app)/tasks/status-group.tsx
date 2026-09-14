"use client";

import { ChevronRight, Inbox } from "lucide-react";

import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import {
  TaskStatusBadge,
  taskStatusEdge,
  taskStatusHeading,
  taskStatusRule,
} from "@/components/status-badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * One stage of the task list, as a panel that collapses.
 *
 * The list and the board are the SAME picture in two shapes: both group by
 * stage, both head a group with the status chip carrying its glyph and its
 * count, and both take that stage's own tone from `status-badge.tsx`. A board
 * column and a list group that disagreed about what "For QA" looks like would
 * be two answers to one question.
 *
 * ⚠️ THEY TAKE DIFFERENT STRENGTHS OF IT, and that is not drift. A board column
 * is a surface with white cards laid on it, so its wash is thinned until a card
 * still reads as raised (`taskStatusSurface`). A list group heading is a bare
 * bar with nothing on it, so it takes the full fill plus a solid spine down the
 * panel (`taskStatusHeading` + `taskStatusEdge`) — which is what makes a column
 * of Open / Ongoing / Completed groups scannable instead of three shades of
 * white. Same tone map, two intensities; see the notes on those helpers.
 *
 * A client component only because the disclosure needs state. The rows are
 * passed in as `children` and stay server-rendered — nothing about a task
 * crosses into the browser bundle to make this open and shut.
 *
 * The chevron is not the only marker: the trigger is a real disclosure button,
 * so `aria-expanded` carries the state to assistive tech, and the count beside
 * the chip says how much is hidden when it is closed.
 */
export function TaskStatusGroup({
  status,
  count,
  defaultOpen = true,
  action,
  children,
}: {
  status: VizservePmsTaskStatus;
  count: number;
  defaultOpen?: boolean;
  /** The group's own "add a task", where that is a true statement. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={cn(
        // The spine is the 4px left edge; `taskStatusEdge` supplies only its
        // colour, so the width stays here with the rest of the panel shape.
        "overflow-hidden rounded-lg border border-l-4 bg-card grade-surface shadow-raised-lg",
        taskStatusEdge(status),
      )}
    >
      {/* `border-b-2` in the stage's own solid, not the hairline. The rows below
          now wear the same fill this bar does, so this line is the only thing
          left dividing heading from body — see `taskStatusRule`. */}
      <div
        className={cn(
          "flex items-center gap-2 border-b-2 px-2 py-2",
          taskStatusHeading(status),
          taskStatusRule(status),
        )}
      >
        <CollapsibleTrigger className="group flex min-w-0 items-center gap-2 rounded-sm px-0.5 py-0.5 text-left">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
          />
          {/* SOLID here, tint on a row: this chip is the group's title, not a
              note among notes. Safe only because no category chip is rendered
              in a heading — see `TONE_SOLID`. */}
          <TaskStatusBadge status={status} icon solid className="uppercase tracking-[0.03em]" />
          {/* `--foreground-muted`, not `--muted-foreground`: on the full-strength
              heading fills the tertiary grey measures 4.41–4.46:1 and misses
              4.5:1. This one holds 5.52–5.70:1 light and 5.97–6.62:1 dark. */}
          <span className="font-mono text-2xs font-semibold tabular-nums text-foreground-muted">
            {count}
          </span>
        </CollapsibleTrigger>

        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>

      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Client requests waiting on Gate 1, as a group above the stages.
 *
 * A SIBLING OF `TaskStatusGroup`, NOT A CALL INTO IT. That component takes a
 * `VizservePmsTaskStatus` and washes its heading in that status' own tone, so
 * it cannot express a group that is not a stage — and "Awaiting approval" is
 * not a stage. Nothing in it has a status yet; that is the whole point of it.
 *
 * Dashed and muted rather than tinted, for the same reason: a heading painted
 * like the others would read as the step before Open, and these rows have not
 * been agreed to at all. The two share the disclosure shape because they sit in
 * one column and should open and shut alike — they deliberately do not share a
 * palette.
 */
export function PendingGroup({
  count,
  defaultOpen = true,
  children,
}: {
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="overflow-hidden rounded-lg border border-dashed bg-card grade-surface shadow-raised-lg"
    >
      <div className="flex items-center gap-2 border-b border-dashed bg-muted/40 px-2 py-2">
        <CollapsibleTrigger className="group flex min-w-0 items-center gap-2 rounded-sm px-0.5 py-0.5 text-left">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90"
          />
          <Inbox className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {/* The words, not a coloured pill. Every other heading in this column
              carries its label; this one has no status to name, so it names the
              thing it is waiting for. */}
          <span className="text-2xs font-semibold tracking-[0.03em] uppercase text-muted-foreground">
            Awaiting approval
          </span>
          <span className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
            {count}
          </span>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

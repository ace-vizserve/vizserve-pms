"use client";

import { CalendarDays, Users } from "lucide-react";

import { formatDate } from "@/lib/dates";
import { LEAVE_PORTION_LABELS, portionOfDay } from "@/lib/leave";
import type { DayHalf } from "@/lib/leave";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * P7-42 — the hover card on a leave calendar name.
 *
 * THE ONLY CLIENT COMPONENT IN `_home/`, and deliberately the smallest one that
 * could work. `leave-calendar.tsx` renders 42 cells, buckets every span into
 * them, and navigates months with plain `<Link>`s — none of which needs to reach
 * the browser. Only the hover target does, so only the hover target crosses the
 * boundary. Marking the calendar itself `"use client"` would have been a
 * two-character diff that shipped the whole grid.
 *
 * WHAT THE CARD MAY SAY IS DECIDED IN POSTGRES, NOT HERE.
 * `vizserve_pms_leave_types.calendar_visibility` gives every type one of three
 * levels, and by the time a row reaches this file the function has already
 * dropped what must not be seen and nulled what must not be named. That is why
 * there is no allow-list here, no `if (type === "VAWC")`, and nothing that would
 * need editing when HR adds a tenth leave type. A confidential row simply never
 * arrives.
 *
 * `typeLabel: null` therefore has TWO causes this component cannot tell apart
 * and must not try to: leave filed before P7-12 had no type at all, and a
 * LABEL_HIDDEN type is withholding one. Both read "On leave", which is true of
 * both.
 *
 * THE TRIGGER IS A REAL BUTTON — `TooltipTrigger`'s own default element, not a
 * styled `<span>`. A span is not focusable, so a span-triggered tooltip is
 * reachable with a mouse and by nothing else, and this card is the only place
 * the halves and the type appear on the screen at all.
 *
 * `delay={0}` ON EVERY TRIGGER, and no `TooltipProvider` above them. `/` is
 * `app/page.tsx` and sits OUTSIDE the `(app)` route group on purpose — no
 * sidebar, no breadcrumb — so the provider wrapping the authenticated shell
 * never reaches this page. Base UI keeps the delay on the trigger and defaults
 * it to 600ms, so inheriting nothing would leave these cards feeling half a
 * second slower than every other tooltip in the app rather than plainly broken,
 * which is the sort of difference nobody traces back to a missing provider.
 * Setting it here matches what `TooltipProvider` sets, and leaves each card
 * self-sufficient — the right shape for a component used on a page with no shell.
 */

/**
 * One row of the calendar, as `app/page.tsx` assembles it.
 *
 * Defined HERE rather than in `leave-calendar.tsx` so the dependency runs one
 * way — the calendar imports the leaf, never the reverse. The calendar
 * re-exports it, so existing importers are untouched.
 */
export type LeaveSpan = {
  userId: string;
  name: string;
  start: string;
  end: string;
  /** Null on rows that predate P7-16. Treated as a whole day. */
  startHalf: DayHalf | null;
  endHalf: DayHalf | null;
  /** Null when unknown OR withheld — the two are indistinguishable here. */
  typeLabel: string | null;
  pending?: boolean;
};

/** `Rina Cruz` → `R. Cruz`. A full name does not fit a calendar cell. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "—";

  return `${parts[0]![0]!.toUpperCase()}. ${parts[parts.length - 1]}`;
}

/** "Vacation Leave", or the honest fallback when the type is unknown or held. */
function typeLine(span: LeaveSpan): string {
  const label = span.typeLabel ?? "On leave";

  return span.pending ? `${label} · awaiting review` : label;
}

/**
 * The span, in one line.
 *
 * A single day states its portion outright; a range qualifies whichever end the
 * halves actually clip and says nothing about the end they do not. "28 Aug 2026
 * · from midday → 1 Sep 2026" is the shape a request genuinely has.
 */
function spanLine(span: LeaveSpan): string {
  if (span.start === span.end) {
    const portion = portionOfDay(span.start, span.start, span.end, span.startHalf, span.endHalf);

    return portion === "full"
      ? formatDate(span.start)
      : `${formatDate(span.start)} · ${LEAVE_PORTION_LABELS[portion].toLowerCase()} only`;
  }

  const from = span.startHalf === "AFTERNOON" ? " · from midday" : "";
  const to = span.endHalf === "MORNING" ? " · until midday" : "";

  return `${formatDate(span.start)}${from} → ${formatDate(span.end)}${to}`;
}

/**
 * "Morning only", for the cell being hovered, when that adds something.
 *
 * Only ever on a multi-day span: on a single day `spanLine` has already said it,
 * and repeating it makes the card look like it is padding.
 */
function dayLine(span: LeaveSpan, day: string | null): string | null {
  if (!day || span.start === span.end) return null;

  const portion = portionOfDay(day, span.start, span.end, span.startHalf, span.endHalf);
  if (portion === "full") return null;

  return `This day: ${LEAVE_PORTION_LABELS[portion].toLowerCase()} only`;
}

/** The whole card as one sentence, for a screen reader. */
function summary(span: LeaveSpan, day: string | null): string {
  return [span.name, typeLine(span), spanLine(span), dayLine(span, day)].filter(Boolean).join(". ");
}

/**
 * The hover card, wrapped around whatever the caller wants as its target.
 *
 * Shared by the calendar cell and the "Out today" list so the two can never word
 * the same absence differently — they are already built from one `spans` array,
 * and this keeps the wording on the same footing too.
 */
export function LeaveTooltip({
  span,
  day = null,
  className,
  children,
}: {
  span: LeaveSpan;
  /** The cell being hovered, or null when the target is not one day. */
  day?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const onThisDay = dayLine(span, day);

  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        className={cn(
          // It reads as text and behaves as a control: no button chrome and no
          // pointer cursor, but a real tab stop and a real focus ring.
          "cursor-default rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        {children}
        {/* The visible text is an abbreviation of this, so it is hidden from the
            accessibility tree rather than read out beside it. */}
        <span className="sr-only">{summary(span, day)}</span>
      </TooltipTrigger>

      <TooltipContent className="max-w-64 py-3 text-pretty">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CalendarDays className="size-4 shrink-0" aria-hidden />
            <p className="text-sm font-medium">{span.name}</p>
          </div>
          <p className="text-background/80">{typeLine(span)}</p>
          <p className="text-background/80 tabular-nums">{spanLine(span)}</p>
          {onThisDay ? <p className="text-background/80">{onThisDay}</p> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** A name in a day cell. The tint says approved or pending; the label says who. */
export function LeaveEntry({ span, day }: { span: LeaveSpan; day: string }) {
  return (
    <LeaveTooltip
      span={span}
      day={day}
      className={cn(
        "block w-full truncate text-2xs font-medium",
        span.pending ? "text-warning" : "text-info",
      )}
    >
      <span aria-hidden>{shortName(span.name)}</span>
    </LeaveTooltip>
  );
}

/**
 * The overflow counter, which used to be a dead end.
 *
 * "+2 more" told you a cell was hiding something and gave you no way to see it —
 * the calendar has no detail route, because P7-10 decided nothing may be looked
 * up or acted on from a cell. One card listing the names answers the question
 * without adding a link that would then have to lead somewhere.
 */
export function MoreLeaveTooltip({ spans, day }: { spans: LeaveSpan[]; day: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        className="cursor-default rounded-xs text-left text-2xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        +{spans.length} more
      </TooltipTrigger>

      <TooltipContent className="max-w-72 py-3 text-pretty">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Users className="size-4 shrink-0" aria-hidden />
            <p className="text-sm font-medium">
              {spans.length} more out on {formatDate(day)}
            </p>
          </div>
          <ul className="space-y-1">
            {spans.map((span) => (
              <li key={`${span.userId}-${span.start}`} className="text-background/80">
                <span className="font-medium text-background">{span.name}</span> — {typeLine(span)}
              </li>
            ))}
          </ul>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

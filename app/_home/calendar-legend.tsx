"use client";

import { useState } from "react";

import { formatDate, formatWeekday } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

import {
  CALENDAR_TONES,
  type CalendarFilterKind,
  type CalendarMatch,
} from "./calendar-tones";

/**
 * P7-35c — the legend, which is a FILTER now.
 *
 * THE GRID STAYS ON THE SERVER, and that is the whole shape of this file. P7-42
 * drew a line through `_home/`: `leave-calendar.tsx` buckets every span into 42
 * cells and navigates months with plain `<Link>`s, none of which needs to reach
 * the browser, so only the hover target crossed the boundary. Making the
 * calendar `"use client"` to hold one piece of filter state would have been a
 * two-character diff that shipped the entire grid — the exact trade that comment
 * was written to refuse.
 *
 * So the grid arrives here as `children`. A server component passed as children
 * to a client one is still rendered on the server; this file never sees a cell.
 * What it owns is one string of state and the legend that sets it.
 *
 * HOW THE DIMMING WORKS, since it is not obvious from this file alone. The
 * wrapper below publishes the active kind as `data-calendar-filter`, and each
 * cell the grid rendered carries its own `data-day-kinds` — a space-separated
 * list, because a Tuesday can be a holiday AND somebody's approved leave AND
 * today all at once. `app/globals.css` matches the two with one rule per kind
 * and fades everything that does not hold the active one.
 *
 * ⚠️ IT HAS TO BE CSS. An attribute selector cannot compare one element's
 * attribute against an ancestor's, so the rule cannot be written generically,
 * and this component cannot reach into server-rendered children to mark them
 * itself. `tests/unit/calendar-tones.test.ts` guards the list that results.
 *
 * A FILTER THAT HIDES NOTHING. Dimmed cells stay in the grid, greyed rather than
 * removed, because the thing being filtered is a CALENDAR — a February with the
 * other 26 days deleted is not a calendar, it is a list, and the whole value of
 * seeing that the two Chinese New Year days are a Tuesday and a Wednesday comes
 * from the shape around them.
 */

export type LegendItem = {
  kind: CalendarFilterKind;
  /** The dates this kind covers in the month on screen, in order. */
  matches: CalendarMatch[];
};

export function CalendarLegend({
  items,
  children,
  footnote,
}: {
  items: LegendItem[];
  /** The server-rendered grid. Never inspected here — only wrapped. */
  children: React.ReactNode;
  footnote: string;
}) {
  const [active, setActive] = useState<CalendarFilterKind | null>(null);
  const activeItem = active ? items.find((item) => item.kind === active) : undefined;

  return (
    <>
      {/* `data-calendar-filter` is absent rather than empty when nothing is
          filtered, so the CSS can key off its mere presence for the base fade
          and never has to special-case a falsy value. */}
      <div data-calendar-filter={active ?? undefined} className="contents">
        {children}
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 pt-1">
        {items.map((item) => {
          const tone = CALENDAR_TONES[item.kind];
          const isActive = item.kind === active;

          return (
            <Button
              key={item.kind}
              type="button"
              variant="ghost"
              size="xs"
              // A toggle, so `aria-pressed` — not `aria-selected`, which belongs
              // to a listbox, and not a bare visual state. Pressing the active
              // one again clears the filter, which is what every user tries
              // first and what makes this safe to explore.
              aria-pressed={isActive}
              onClick={() => setActive(isActive ? null : item.kind)}
              className={cn(
                "text-2xs font-normal text-muted-foreground",
                // The pressed state is NOT carried by the swatch going solid —
                // the swatches are already solid. It is the chip filling with
                // the brand accent and the label going semibold, so the control
                // survives greyscale, which §5.5 requires of every state.
                isActive && "bg-accent font-semibold text-accent-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn("size-2.5 shrink-0 rounded-xs border", tone.swatch)}
              />
              {tone.label}
              <span className="tabular-nums text-muted-foreground">{item.matches.length}</span>
            </Button>
          );
        })}

        {/* P7-42 wrote this sentence and the second clause is load-bearing: a
            calendar that withholds two leave types outright owes its readers a
            line saying so, or it is quietly wrong about who is in. */}
        <span className="ml-auto text-2xs text-muted-foreground">{footnote}</span>
      </div>

      {/* The answer to "which dates are those", which is the question a swatch
          provokes and the cell tint alone never answers — a holiday on the 17th
          is easy to miss in a grid of 42.

          A LIVE REGION, and one of the few places §5.6 permits one: it is empty
          until a click fills it, so it announces a result the user just asked
          for rather than narrating the page. It stays mounted while empty
          because a region inserted at the moment it gains content is announced
          unreliably. */}
      <div aria-live="polite" className="min-h-0">
        {activeItem ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-2xs">
            <span className="font-semibold text-foreground">
              {CALENDAR_TONES[activeItem.kind].label}
            </span>

            {activeItem.matches.length === 0 ? (
              <span className="text-muted-foreground">
                Nothing this month. Use the arrows above to look at another.
              </span>
            ) : (
              activeItem.matches.map((match) => (
                <span
                  key={match.date}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
                    // The same surface the matching cell wears, so the chip and
                    // the cell it points at are recognisably the same thing.
                    CALENDAR_TONES[activeItem.kind].surface,
                    CALENDAR_TONES[activeItem.kind].text,
                  )}
                >
                  <span className="font-semibold tabular-nums">
                    {formatWeekday(match.date)} {formatDate(match.date)}
                  </span>
                  <span className="font-normal opacity-90">{match.label}</span>
                </span>
              ))
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

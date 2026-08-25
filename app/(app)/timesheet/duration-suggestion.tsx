"use client";

import { type RefObject, useState } from "react";

import { Popover, PopoverContent } from "@/components/ui/popover";
import { parseCellDuration, spellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

/**
 * WHAT THE FIELD JUST HEARD, WHILE THERE IS STILL TIME TO DISAGREE.
 *
 * `parseCellDuration` accepts several spellings of the same length — `1h 30m`,
 * `90m`, `1.5` — and a bare number is HOURS. That last rule is the one that
 * catches people: `1.5` typed by somebody who meant an hour and five minutes is
 * a 25-minute error in a payroll record, and nothing on screen said which
 * reading it got until after it saved.
 *
 * So the field says it back in words, as something you can click. Words, not
 * `1h 30m`, because echoing the same notation the person just typed is not a
 * second opinion — "1 hour 30 minutes" is.
 *
 * NOTHING is suggested for input that does not parse. A dropdown that appears
 * mid-word to say "no" is noise; the toast on commit already names the problem,
 * once, when there is something to name.
 */
export function DurationSuggestion({
  anchor,
  value,
  onAccept,
  inline = false,
}: {
  /** The field this hangs under. */
  anchor: RefObject<HTMLInputElement | null>;
  /** The raw text, as typed. */
  value: string;
  /** Clicking the suggestion. The minutes are what the field was understood as. */
  onAccept: (minutes: number) => void;
  /**
   * Position it in the flow rather than through a portal.
   *
   * The week grid needs the portal: its table scrolls horizontally, and a
   * `overflow-x` container clips its other axis too, so a dropdown drawn inside
   * a cell is cut off on the bottom row. Inside a popover there is nothing to
   * clip it and a portal would mean a popover nested in a popover, where an
   * outside-click on the inner one is one dismissal rule away from closing the
   * outer.
   */
  inline?: boolean;
}) {
  const minutes = parseCellDuration(value);

  /*
   * TAKEN, AND SO OUT OF THE WAY.
   *
   * Accepting writes the canonical spelling back into the field, which parses
   * to the same length — so without this the suggestion would still be sitting
   * there afterwards, covering the row it just filled in and looking like a
   * click that did nothing.
   *
   * Keyed on the LENGTH rather than the text: `1h` and `1 hour` and `60m` are
   * one suggestion and it stays dismissed across all three. Emptying the field
   * clears it, so retyping the same length asks again.
   */
  const [taken, setTaken] = useState<number | null>(null);

  // Adjusted DURING RENDER, which is the pattern React documents for state that
  // depends on a prop — and which `TimePicker` already uses for the same reason.
  // An effect would render one frame with the stale dismissal, and the
  // `react-hooks` rule rejects it outright.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (!value.trim()) setTaken(null);
  }

  const open = value.trim().length > 0 && minutes !== null && minutes > 0 && minutes !== taken;

  if (!open) return null;

  const card = (
    <button
      type="button"
      // The field keeps focus and the caret. Without this the pointer-down
      // blurs the input, which COMMITS it — the click would land on a
      // suggestion for a value that had already been saved and cleared.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        setTaken(minutes);
        onAccept(minutes);
      }}
      className={cn(
        "flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-sm",
        "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      )}>
      {spellDuration(minutes)}
    </button>
  );

  if (inline) {
    return (
      <div className="absolute inset-x-0 top-full z-50 mt-1 rounded-lg border bg-popover p-1 shadow-overlay">
        {card}
      </div>
    );
  }

  return (
    <Popover open>
      <PopoverContent
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={2}
        // The popup must not take focus — the person is still typing into the
        // field it is describing — and must not hand it anywhere on the way
        // out either, or every commit would move the caret.
        initialFocus={false}
        finalFocus={false}
        className="w-max min-w-40 gap-0 p-1">
        {card}
      </PopoverContent>
    </Popover>
  );
}

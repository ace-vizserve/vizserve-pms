"use client";

import { useEffect, useRef, useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { joinClock, splitClock } from "@/components/ui/time-picker";
import { clockAt, minutesBetween, nearestQuarterHour } from "@/lib/schemas/timesheet";

/**
 * THE CLOCK CONTROLS, SHARED BY THE TWO PLACES AN ENTRY IS EDITED.
 *
 * The popover and the week grid's expanded rows both edit the same pair of
 * columns, and both had to answer the same three questions — what a time reads
 * as, what a field may be set to, and where a list of them opens. Kept in one
 * module rather than one copy each, for the reason this repo keeps writing
 * down: every duplicated map in here has drifted.
 *
 * The arithmetic underneath lives in `lib/schemas/timesheet.ts` and is tested
 * without React. This file is the rendering.
 */

/** `09:05` → `9:05 am`. */
export function clockLabel(value: string): string {
  const parts = splitClock(value);
  if (!parts) return "";
  return `${parts.hour12}:${String(parts.minute).padStart(2, "0")} ${parts.meridiem.toLowerCase()}`;
}

/**
 * `09:05:00` → `09:05`, and anything unreadable → `""`.
 *
 * Postgres hands `time` back with seconds on it. A select whose `value` is
 * `"09:05:00"` while its options are `"09:05"` matches nothing and renders
 * blank, so every clock string entering this file goes through here first.
 */
export function normaliseClock(value: string | null | undefined): string {
  const parts = splitClock(value);
  return parts ? joinClock(parts.hour12, parts.minute, parts.meridiem) : "";
}

/** Every quarter hour of a day, `00:00` … `23:45`. */
const QUARTER_HOURS: readonly string[] = Array.from({ length: (24 * 60) / 15 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

/** Minutes since midnight, using the arithmetic that already exists. */
function sinceMidnight(value: string): number {
  return minutesBetween("00:00", value);
}

/**
 * What one clock field may be set to.
 *
 * Quarter hours, because that is the grain a timesheet is read at and a list of
 * 1,440 minutes is not a list anybody can use. Two things get added back:
 *
 *   `current` — the value in the field, whether or not it sits on the grid. The
 *               default start is the clock as it actually is (2:41 pm), and an
 *               entry saved before this control existed can hold anything. A
 *               select whose value is missing from its options renders empty,
 *               which would silently look like no time at all.
 *
 *   `after`   — the end field only offers times later than the start, so "the
 *               end must be after the start" stops being an error somebody can
 *               make. The constraint still exists in the database; this is
 *               about not offering the wrong answer in the first place.
 */
function clockOptions(current: string, after?: string): { value: string; label: string }[] {
  const floor = after ? sinceMidnight(after) : -1;
  const values = QUARTER_HOURS.filter((value) => sinceMidnight(value) > floor);
  const all = current && !values.includes(current) ? [...values, current].sort() : values;

  return all.map((value) => ({ value, label: clockLabel(value) }));
}

/** One clock field. `Select`, so the keyboard, typeahead and scrolling are free. */
export function ClockSelect({
  label,
  value,
  onChange,
  after,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** For the end field: the start it has to follow. */
  after?: string;
  disabled?: boolean;
}) {
  const options = clockOptions(value, after);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  /*
   * AN UNSET FIELD OPENS WHERE THE DAY IS, NOT AT MIDNIGHT.
   *
   * A field with a value scrolls itself — a select puts the chosen row in view
   * on its own. An empty one has nothing to scroll to, so it opens at `12:00
   * am` and leaves somebody logging an afternoon to drag past fourteen hours
   * they are never going to pick.
   *
   * The frame is needed: `onOpenChange` fires as the popup mounts, and the row
   * being scrolled to does not exist until it has.
   */
  useEffect(() => {
    if (!open || value) return;

    const frame = requestAnimationFrame(() => {
      const target = nearestQuarterHour(clockAt());
      // Missing when the end field's list starts after `now` — the first row
      // is then already the right place to be, so there is nothing to do.
      popupRef.current?.querySelector(`[data-clock="${target}"]`)?.scrollIntoView({ block: "center" });
    });

    return () => cancelAnimationFrame(frame);
  }, [open, value]);

  return (
    <Select
      items={options}
      value={value || null}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(next) => typeof next === "string" && onChange(next)}>
      <SelectTrigger size="sm" aria-label={label} className="min-w-24 tabular-nums">
        <SelectValue placeholder="Set time" />
      </SelectTrigger>
      <SelectContent ref={popupRef}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            // The handle the scroll above reaches for. `value` is on the Base
            // UI item as a prop, not as an attribute, so it is not queryable.
            data-clock={option.value}
            className="tabular-nums">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

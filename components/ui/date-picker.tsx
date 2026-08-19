"use client";

import * as React from "react";
import { CalendarIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, parseDateOnly } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * A date field that opens the app's own calendar instead of the browser's.
 *
 * `components/ui/calendar.tsx` and `react-day-picker` were both already in the
 * repo and **nothing imported either of them** — every one of the twenty date
 * fields in the app was `<Input type="date">`, which renders whatever the
 * browser feels like. That is three different controls across Chrome, Safari and
 * Firefox, none of them carrying our tokens, none of them dark-mode aware, and
 * one of them (Safari) with no calendar at all on desktop.
 *
 * ⚠️ THE VALUE IS A BARE `YYYY-MM-DD` STRING, never a Date, and every boundary
 * of this component converts explicitly. Getting that wrong is the single
 * easiest way to move somebody's leave by a day:
 *
 *   in  — `parseDateOnly` reads the string as MIDDAY UTC, which is the whole
 *         reason it exists (`lib/dates.ts`): midnight lands on the previous day
 *         in any negative offset, so a midnight-parsed date renders as the wrong
 *         cell for anyone west of Greenwich.
 *
 *   out — read back from the picked Date's LOCAL components, deliberately NOT
 *         through `toAppDateString`. That helper answers "what is the date in
 *         Manila for this instant", which is right for a timestamp and wrong
 *         here: the user clicked a cell labelled 3 September and must get
 *         "2026-09-03" whatever timezone their laptop is in. This is also
 *         exactly what `<input type="date">` did, so no stored value shifts.
 *
 * No date library — `dayjs`/`date-fns`/`moment` are banned. `react-day-picker`
 * is a calendar widget, not a date library, and it was already a dependency.
 */

/**
 * The picked day, as the day it was labelled — not as an instant.
 *
 * Exported because `InlineDate` and the composer's date popover render a
 * `Calendar` directly (they already sit inside a Popover, and nesting one inside
 * another traps focus in the wrong layer). They need the same string conversion,
 * and a second copy of it is a second place for the timezone rule to drift.
 */
export function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function DatePicker({
  value,
  onChange,
  id,
  name,
  min,
  max,
  disabled,
  clearable = true,
  placeholder = "Choose a date",
  invalid,
  className,
}: {
  /** `YYYY-MM-DD`, or null/"" for empty. */
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  id?: string;
  /**
   * Renders a hidden input, for the dialogs that still submit through a native
   * `<form action>` and read FormData. Omit it in a controlled form.
   */
  name?: string;
  /** `YYYY-MM-DD` bounds. Days outside them are unselectable, not merely ugly. */
  min?: string;
  max?: string;
  disabled?: boolean;
  clearable?: boolean;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  const selected = value ? (parseDateOnly(value) ?? undefined) : undefined;
  const fromDate = min ? (parseDateOnly(min) ?? undefined) : undefined;
  const toDate = max ? (parseDateOnly(max) ?? undefined) : undefined;

  return (
    <div data-slot="date-picker" className={cn("relative", className)}>
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              id={id}
              variant="outline"
              disabled={disabled}
              aria-invalid={invalid || undefined}
              // `justify-start` and a full width so it lines up with the Inputs
              // beside it — a date field that is narrower than its neighbours
              // reads as a different kind of thing.
              className={cn(
                "w-full justify-start gap-2 font-normal",
                !value && "text-muted-foreground",
                // Room for the clear button, so a long date never slides under it.
                clearable && value && "pr-9",
              )}
            >
              <CalendarIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{value ? formatDate(value) : placeholder}</span>
            </Button>
          }
        />

        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            autoFocus
            selected={selected}
            defaultMonth={selected}
            startMonth={fromDate}
            endMonth={toDate}
            disabled={
              fromDate || toDate ? { before: fromDate as Date, after: toDate as Date } : undefined
            }
            onSelect={(date) => {
              onChange(date ? toDateString(date) : null);
              // Closing on pick is the whole point of a single-date picker;
              // leaving it open makes people hunt for a Done button that is not
              // there.
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      {/*
       * Clearing needs its own control. A native date input has one built in and
       * this does not, so without it an optional date becomes permanent the
       * moment somebody fills it in by accident.
       *
       * Outside the trigger rather than inside it: a button inside a button is
       * invalid HTML and the inner one stops receiving clicks in Safari.
       */}
      {clearable && value && !disabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Clear date"
          className="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null)}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

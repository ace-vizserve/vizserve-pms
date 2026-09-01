"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCellDuration, parseCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

/**
 * P7-15 / K5 — how long somebody expects this to take.
 *
 * IT REUSES THE TIMESHEET'S PARSER, and that is the whole reason this is a
 * component rather than a bare `<Input type="number">`. `parseCellDuration`
 * reads `2h 30m`, `90m` and a bare `1.5` as hours; `formatCellDuration` writes
 * it back. So `2h` means the same thing in an estimate as it does in a timesheet
 * cell — which matters more here than anywhere, because an estimate exists to be
 * compared against the hours actually logged.
 *
 * Minutes on the wire, like every other duration in this codebase. The string is
 * a rendering, never the stored value.
 *
 * Burndown stays out of scope (docs/07:105). This is a field; burndown is a
 * report with a velocity model behind it, and nobody has asked for one.
 */
export function EstimateField({
  value,
  onChange,
  disabled,
  id = "estimate",
  label = "Estimate",
  hint,
  className,
}: {
  value: number | null;
  onChange: (minutes: number | null) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  /**
   * P7-55. Replaces the default hint when there is something more useful to
   * say about THIS estimate — the task detail page passes the time actually
   * logged against it, which used to be a free-standing paragraph below the
   * grid. An error always wins over both: a field that is refusing must say so
   * before it says anything else.
   */
  hint?: React.ReactNode;
  /** Lets a caller size the field to its column. */
  className?: string;
}) {
  /**
   * The text is local; the minutes are the caller's.
   *
   * Keeping the raw string here is what lets somebody type "2h 3" without the
   * half-finished value being parsed, rejected, and reformatted under the
   * cursor. It is committed on blur.
   */
  const [raw, setRaw] = useState(value === null ? "" : formatCellDuration(value));
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = raw.trim();

    // Empty is a real instruction — "nobody estimated this" — and it is the
    // ordinary state, so it must not be an error.
    if (!trimmed) {
      setError(null);
      onChange(null);
      return;
    }

    const minutes = parseCellDuration(trimmed);

    // `parseCellDuration` returns 0 for empty, which is handled above, and null
    // for input that means nothing. A typed colon is in the second group on
    // purpose — see CELL_COLON_LIKE.
    if (minutes === null || minutes === 0) {
      setError("Try 2h, 90m or 1.5 — a colon reads as a clock, so it is refused.");
      return;
    }

    setError(null);
    onChange(minutes);
    // Reformatted in place, so a wrong reading of `1.5` is visible where it was
    // typed rather than discovered later in a report.
    setRaw(formatCellDuration(minutes));
  }

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={raw}
        disabled={disabled}
        inputMode="text"
        placeholder="2h 30m"
        aria-describedby={`${id}-hint`}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setRaw(event.target.value)}
        onBlur={commit}
        // Enter commits without submitting the form around it — a half-typed
        // estimate must not post the dialog.
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <p id={`${id}-hint`} className="text-2xs text-muted-foreground">
        {error ?? hint ?? "Hours and minutes, as in a timesheet cell. A plain number is hours."}
      </p>
    </div>
  );
}

"use client";

import * as React from "react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

/**
 * A time field that renders our own controls instead of the browser's.
 *
 * `<input type="time">` was the last native control left in the app, and it is
 * the worst of them: Chrome draws a 24-hour spinner, Safari draws a 12-hour one
 * with its own AM/PM stepper, Firefox draws a third thing, and none of them
 * carries a token, a focus ring or a dark mode. The same field looked like three
 * different fields depending on who opened it — which is exactly the reason
 * `DatePicker` exists, arrived at again one control later.
 *
 * ⚠️ THE VALUE IS 24-HOUR `HH:MM`, THE DISPLAY IS 12-HOUR. Every boundary
 * converts explicitly, and the split is the whole design:
 *
 *   in/out — `HH:MM`, 24-hour, zero-padded. That is what `lib/schemas`'
 *            `timeOfDay` regex accepts, what `minutesBetween` does arithmetic
 *            on, and what Postgres `time` columns round-trip. Nothing
 *            downstream ever sees "7:05 PM".
 *
 *   shown  — hour 1–12, minutes, and a meridiem segment, because that is how
 *            everybody here says a shift out loud.
 *
 * Emitting a 12-hour string would break the schemas; storing a 12-hour string
 * would break the day-length arithmetic on either side of noon. Neither is
 * possible from outside this file.
 *
 * EMPTY IS A VALUE. Work hours are optional and a timesheet entry may carry no
 * times at all, so a half-filled field emits `null` rather than a guess — an
 * hour with no minutes is not 07:00, it is somebody mid-keystroke.
 */

const MERIDIEMS = ["AM", "PM"] as const;

export type Meridiem = (typeof MERIDIEMS)[number];

/** 24-hour `HH:MM` → the three things the control displays. */
export function splitClock(
  value: string | null | undefined,
): { hour12: number; minute: number; meridiem: Meridiem } | null {
  if (!value) return null;

  // Postgres hands back `HH:MM:SS`; the seconds are not ours to show or keep.
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value.trim());
  if (!match) return null;

  const hour24 = Number(match[1]);
  return {
    // 0 → 12 AM and 12 → 12 PM. The `|| 12` is what stops midnight rendering
    // as "0" and noon as "0 PM".
    hour12: hour24 % 12 || 12,
    minute: Number(match[2]),
    meridiem: hour24 >= 12 ? "PM" : "AM",
  };
}

/** The three displayed things → 24-hour `HH:MM`. */
export function joinClock(hour12: number, minute: number, meridiem: Meridiem): string {
  const base = hour12 % 12;
  const hour24 = meridiem === "PM" ? base + 12 : base;
  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Digits only, capped at two — a paste of "9:30pm" must not land in the box. */
function digits(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 2);
}

const segmentBox = cn(
  "h-10 rounded-md border border-input bg-muted text-center text-sm tabular-nums",
  "transition-colors outline-none",
  "placeholder:text-muted-foreground",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
  "dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
);

export function TimePicker({
  value,
  onChange,
  id,
  name,
  label = "Time",
  size = "default",
  disabled,
  readOnly,
  invalid,
  onBlur,
  className,
}: {
  /** 24-hour `HH:MM`, or null/"" for empty. `HH:MM:SS` is accepted and trimmed. */
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  /**
   * Lands on the HOUR box, so a `<Label htmlFor>` beside this focuses the first
   * thing a person would type into.
   */
  id?: string;
  /**
   * Renders a hidden input carrying the 24-hour value, for the dialogs that
   * still submit through a native `<form action>` and read FormData.
   */
  name?: string;
  /**
   * Names the group for assistive tech, and prefixes each box — "Scheduled
   * start hour" rather than a bare "hour" three fields down a form.
   */
  label?: string;
  /** `sm` (32px) for the dense timesheet rows; `default` (40px) beside an Input. */
  size?: "sm" | "default";
  disabled?: boolean;
  /**
   * Readable and focusable but not editable — a locked timesheet week, where
   * the value still has to be selectable and the reason lives beside the field.
   * The meridiem segment falls back to `disabled`, since a radio group has no
   * read-only state to offer.
   */
  readOnly?: boolean;
  invalid?: boolean;
  /**
   * Fires when focus leaves the WHOLE control, not when it moves between the
   * hour and the minute. The timesheet saves on blur, and a save firing as
   * somebody tabs from hour to minutes would write a half-typed time.
   */
  onBlur?: () => void;
  className?: string;
}) {
  const parsed = splitClock(value);

  const compact = size === "sm";
  const boxSize = compact ? "h-8 w-9 text-xs" : "h-10 w-11 text-sm";
  const groupHeight = compact ? "h-8" : "h-10";

  /*
   * Local text state, because a controlled input cannot hold a half-typed hour.
   * Someone typing "1" on the way to "12" would have it normalised to "01" on
   * the first keystroke and could never reach 12 at all.
   */
  const [hourText, setHourText] = React.useState(parsed ? String(parsed.hour12) : "");
  const [minuteText, setMinuteText] = React.useState(
    parsed ? String(parsed.minute).padStart(2, "0") : "",
  );
  const [meridiem, setMeridiem] = React.useState<Meridiem>(parsed?.meridiem ?? "AM");

  const minuteRef = React.useRef<HTMLInputElement>(null);
  const hourRef = React.useRef<HTMLInputElement>(null);

  /** What the boxes currently add up to, or null while one of them is empty. */
  const current = React.useMemo(() => {
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!hourText || !minuteText || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return joinClock(hour, minute, meridiem);
  }, [hourText, minuteText, meridiem]);

  /*
   * Adjusting state when a prop changes — done DURING RENDER, which is the
   * pattern React documents for exactly this, rather than in an effect. An
   * effect would render one frame with the stale time, and `react-hooks`
   * rejects it outright.
   *
   * TWO comparisons, and both are load-bearing:
   *
   *   normalised !== synced   has the prop changed at all since we last looked?
   *   normalised !== current  did it change to something the boxes do not
   *                           already say?
   *
   * The second is what stops the control fighting the person typing. Every
   * keystroke emits upward and comes back as a new `value`, so without it a
   * minute typed as "5" — on the way to "50" — is round-tripped, reformatted to
   * "05", and the caret jumps. With it, that echo is recognised as our own and
   * only a genuinely external change — a form reset, a prefill arriving late —
   * rewrites the boxes.
   */
  const incoming = splitClock(value);
  const normalised = incoming ? joinClock(incoming.hour12, incoming.minute, incoming.meridiem) : null;
  const [synced, setSynced] = React.useState(normalised);

  if (normalised !== synced) {
    setSynced(normalised);
    if (normalised !== current) {
      setHourText(incoming ? String(incoming.hour12) : "");
      setMinuteText(incoming ? String(incoming.minute).padStart(2, "0") : "");
      if (incoming) setMeridiem(incoming.meridiem);
    }
  }

  function emit(nextHour: string, nextMinute: string, nextMeridiem: Meridiem) {
    const hour = Number(nextHour);
    const minute = Number(nextMinute);

    // Half-filled emits null. See the header: an hour with no minutes is
    // somebody mid-keystroke, not a time.
    if (!nextHour || !nextMinute || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      onChange(null);
      return;
    }

    onChange(joinClock(clampHour(hour), Math.min(59, minute), nextMeridiem));
  }

  function clampHour(hour: number): number {
    // 0 is what somebody types when they mean 12 — a 12-hour clock has no zero.
    if (hour <= 0) return 12;
    return Math.min(12, hour);
  }

  function commitHour(raw: string) {
    if (readOnly) return;
    const next = digits(raw);
    setHourText(next);
    emit(next, minuteText, meridiem);

    // Advance once the hour cannot take another digit: two digits typed, or a
    // leading digit above 1, where "3" can only ever mean three o'clock.
    if (next.length === 2 || (next.length === 1 && Number(next) > 1)) {
      minuteRef.current?.focus();
      minuteRef.current?.select();
    }
  }

  function commitMinute(raw: string) {
    if (readOnly) return;
    const next = digits(raw);
    setMinuteText(next);
    emit(hourText, next, meridiem);
  }

  function commitMeridiem(next: Meridiem) {
    if (readOnly) return;
    setMeridiem(next);
    emit(hourText, minuteText, next);
  }

  /** Blur is where a half-typed box becomes a real one — "7" → "07". */
  function normalise() {
    if (readOnly) return;
    if (hourText) {
      const hour = clampHour(Number(hourText));
      setHourText(String(hour));
      if (minuteText) {
        const minute = Math.min(59, Number(minuteText));
        setMinuteText(String(minute).padStart(2, "0"));
        onChange(joinClock(hour, minute, meridiem));
        return;
      }
    }
    if (minuteText) setMinuteText(String(Math.min(59, Number(minuteText))).padStart(2, "0"));
  }

  function step(part: "hour" | "minute", delta: number) {
    if (readOnly) return;
    if (part === "hour") {
      const base = hourText ? clampHour(Number(hourText)) : 12;
      // 1–12 wrapping, which `%` alone will not give you: 12 + 1 must be 1, and
      // 1 − 1 must be 12, not 0.
      const next = ((base - 1 + delta + 12) % 12) + 1;
      setHourText(String(next));
      emit(String(next), minuteText, meridiem);
      return;
    }

    const base = minuteText ? Math.min(59, Number(minuteText)) : 0;
    const next = (base + delta + 60) % 60;
    setMinuteText(String(next).padStart(2, "0"));
    emit(hourText, String(next), meridiem);
  }

  function onSegmentKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    part: "hour" | "minute",
  ) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      step(part, 1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(part, -1);
      return;
    }
    // Backspace out of an empty minute box goes back to the hour, the way a
    // single field would have done.
    if (event.key === "Backspace" && part === "minute" && !minuteText) {
      hourRef.current?.focus();
    }
  }

  return (
    <div
      data-slot="time-picker"
      role="group"
      aria-label={label}
      className={cn("inline-flex items-center gap-1.5", className)}
      onBlur={(event) => {
        // Only when focus leaves the GROUP. Moving from the hour box to the
        // minutes fires a blur too, and treating that as "done" would save a
        // time the person is still halfway through typing.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onBlur?.();
      }}
    >
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}

      <input
        ref={hourRef}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="--"
        aria-label={`${label} hour`}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        readOnly={readOnly}
        value={hourText}
        onChange={(event) => commitHour(event.target.value)}
        onKeyDown={(event) => onSegmentKeyDown(event, "hour")}
        onFocus={(event) => event.target.select()}
        onBlur={normalise}
        className={cn(segmentBox, boxSize)}
      />

      {/*
       * Decoration, not information — the two boxes and their labels already
       * say this is a time. `--foreground-faint` is the tertiary grey that is
       * non-text only, and a colon nobody reads is exactly what it is for.
       */}
      <span aria-hidden className="text-sm font-medium text-foreground-faint">
        :
      </span>

      <input
        ref={minuteRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="--"
        aria-label={`${label} minutes`}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        readOnly={readOnly}
        value={minuteText}
        onChange={(event) => commitMinute(event.target.value)}
        onKeyDown={(event) => onSegmentKeyDown(event, "minute")}
        onFocus={(event) => event.target.select()}
        onBlur={normalise}
        className={cn(segmentBox, boxSize)}
      />

      {/*
       * The existing segmented control, not a second one. It already carries the
       * lift-marks-selection rule, the roving arrow keys and the radio
       * semantics — "exactly one of these is true" is precisely AM or PM.
       */}
      <Segmented
        value={meridiem}
        onValueChange={(next) => commitMeridiem(next as Meridiem)}
        disabled={disabled || readOnly}
        aria-label={`${label} AM or PM`}
        className={cn("ml-0.5", groupHeight)}
      >
        {MERIDIEMS.map((option) => (
          <SegmentedItem key={option} value={option} className={cn("h-full", compact ? "px-2" : "px-2.5")}>
            {option}
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}

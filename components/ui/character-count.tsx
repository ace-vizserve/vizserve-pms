"use client";

import { richTextLength } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

/**
 * P11-02 — how much more this field needs, and how much room is left.
 *
 * ⚠️ IT EXISTS TO STOP A BUTTON BEING DISABLED FOR NO STATED REASON. Four
 * screens gated Submit on `reason.trim().length < N` and showed nothing at all:
 * the button was simply dead, and the only way to learn why was to type more
 * and watch it come alive. The count is not decoration here — it is the missing
 * half of a control that was already refusing to work.
 *
 * ⚠️ IT MEASURES WHAT THE SCHEMA MEASURES, which is the whole reason it takes a
 * `rich` flag rather than calling `.length`. On a `RichTextEditor` the value is
 * markup: `<p><strong>no</strong></p>` is 26 characters of it and 2 of prose.
 * A counter reading 26 beside a schema that reads 2 is worse than no counter,
 * because it makes the refusal look like a bug. `richTextLength` is the same
 * flattener `richTextSchema` uses.
 *
 * ⚠️ QUIET UNTIL IT HAS SOMETHING TO SAY. It speaks below the minimum, and again
 * within 10% of the cap. In between it renders nothing — a running total on a
 * 2,000-character field somebody is writing forty words into is noise, and this
 * system does not decorate. That leaves one line of text on screen exactly when
 * a person is either not finished or nearly out of room.
 *
 * `aria-live="polite"` rather than `role="alert"`: this is a running state, not
 * an error. The error, when the form is actually submitted, is still
 * `FieldError` with its `role="alert"`.
 */
export function CharacterCount({
  value,
  min = 0,
  max,
  rich = false,
  className,
}: {
  /** The raw field value — markup when `rich`, plain text otherwise. */
  value: string;
  /** The schema's floor. 0 means the field has none. */
  min?: number;
  /** The schema's cap, if it has one. */
  max?: number;
  /** True when the value is HTML from a `RichTextEditor`. */
  rich?: boolean;
  className?: string;
}) {
  const length = rich ? richTextLength(value) : value.trim().length;

  const message = describe(length, min, max);
  if (!message) return null;

  return (
    <p
      aria-live="polite"
      className={cn("text-2xs tabular-nums", TONE[message.tone], className)}
    >
      {message.text}
    </p>
  );
}

const TONE = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  over: "text-destructive",
} as const;

type Message = { text: string; tone: keyof typeof TONE };

/**
 * Separated from the component so it is testable without a DOM, and so the
 * wording lives in one place rather than being assembled inline at six call
 * sites.
 */
export function describe(length: number, min: number, max?: number): Message | null {
  if (max !== undefined && length > max) {
    return {
      // The overage, not the total. "2,041 / 2,000" makes a reader do the
      // subtraction; the thing they need is how much to cut.
      text: `${(length - max).toLocaleString("en-US")} over the limit`,
      tone: "over",
    };
  }

  if (min > 0 && length < min) {
    // Nothing typed yet is a REQUIREMENT, not a shortfall. "10 more characters"
    // on an empty box reads as though something was already counted.
    if (length === 0) return { text: `At least ${min} characters`, tone: "neutral" };

    const needed = min - length;
    return {
      text: `${needed} more character${needed === 1 ? "" : "s"}`,
      tone: "neutral",
    };
  }

  // Within a tenth of the cap. Below that it says nothing at all.
  if (max !== undefined && length >= max * 0.9) {
    return {
      text: `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`,
      tone: "warning",
    };
  }

  return null;
}

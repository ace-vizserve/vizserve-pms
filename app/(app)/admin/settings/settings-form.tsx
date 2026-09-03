"use client";

import { useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_BREAK_MINUTES, MAX_GRACE_MINUTES } from "@/lib/schemas/settings";
import { updateAppSettings } from "./actions";

/**
 * P7-37 / P8-05 — two numbers, and the sentences explaining what each does to
 * everybody.
 *
 * The explanatory text is longer than the controls, deliberately. An admin
 * setting these has to understand that they are company-wide and read on every
 * punch and every week submission, because the failure mode of not
 * understanding is quietly switching lateness reporting — or the timesheet
 * shortfall check — off for the whole company with a plausible-looking number.
 *
 * BOTH FIELDS SAVE TOGETHER, because the action takes the whole settings row.
 * Held as strings until submit, so a half-typed field is a half-typed field
 * rather than a zero on its way into company policy.
 */
export function SettingsForm({
  graceMinutes,
  breakMinutes,
}: {
  graceMinutes: number;
  breakMinutes: number;
}) {
  const [value, setValue] = useState(String(graceMinutes));
  const [breakValue, setBreakValue] = useState(String(breakMinutes));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      setErrors({});

      // Number(""), which is 0, would silently save "exact" for an empty field
      // — and "no unpaid break" for the other one, which would raise everybody's
      // weekly minimum by five hours. NaN reaches the schema and comes back as
      // a sentence on the field.
      const parsedValue = value.trim() === "" ? Number.NaN : Number(value);
      const parsedBreak = breakValue.trim() === "" ? Number.NaN : Number(breakValue);

      const result = await updateAppSettings({
        grace_minutes: parsedValue,
        break_minutes: parsedBreak,
      });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success("Saved. New punches and week submissions are judged against this from now on.");
    });
  }

  const fieldErrors = errors.grace_minutes ?? [];
  const breakErrors = errors.break_minutes ?? [];

  return (
    <form
      className="max-w-md space-y-4 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg"
      action={submit}
    >
      <div className="space-y-2">
        <Label htmlFor="grace_minutes">Grace period</Label>
        <div className="flex items-center gap-2">
          <Input
            id="grace_minutes"
            name="grace_minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_GRACE_MINUTES}
            step={1}
            className="w-24 tabular-nums"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={fieldErrors.length > 0}
            aria-describedby="grace_minutes_hint"
          />
          <span className="text-sm text-muted-foreground">minutes</span>
        </div>

        {fieldErrors.map((message) => (
          <p key={message} className="text-xs text-destructive">
            {message}
          </p>
        ))}

        <p id="grace_minutes_hint" className="text-xs text-muted-foreground">
          How far either side of a scheduled time a punch may land before the DTR offers a
          correction request. It applies at both ends of the day and to everybody who has work
          hours set — someone with no schedule is never prompted, whatever this says. Zero means
          the scheduled time exactly.
        </p>
      </div>

      {/* ----------------------------------------------------------------
          P8-05 — the unpaid break.

          The one field on this screen that can REFUSE something. The grace
          period changes what the DTR says; this changes what a scheduled day
          is worth, and a timesheet week short of it cannot be handed in at
          all. The hint says that in as many words, because an admin raising
          this by an hour is lowering everybody's weekly minimum by five.
          ---------------------------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor="break_minutes">Unpaid break</Label>
        <div className="flex items-center gap-2">
          <Input
            id="break_minutes"
            name="break_minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_BREAK_MINUTES}
            step={1}
            className="w-24 tabular-nums"
            value={breakValue}
            onChange={(event) => setBreakValue(event.target.value)}
            aria-invalid={breakErrors.length > 0}
            aria-describedby="break_minutes_hint"
          />
          <span className="text-sm text-muted-foreground">minutes</span>
        </div>

        {breakErrors.map((message) => (
          <p key={message} className="text-xs text-destructive">
            {message}
          </p>
        ))}

        <p id="break_minutes_hint" className="text-xs text-muted-foreground">
          The break sitting inside the scheduled day. Work hours of 08:00 to 17:00 with an hour
          here describe an eight-hour day, and that is the figure a timesheet week is measured
          against — a week short of it is refused when someone tries to hand it in. Anybody whose
          break differs gets their own figure on their staff record; this is what everyone else
          inherits. Zero means no unpaid break.
        </p>
      </div>

      <Button type="submit" loading={pending}>
        Save
      </Button>
    </form>
  );
}

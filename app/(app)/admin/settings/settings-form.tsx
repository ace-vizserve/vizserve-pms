"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_GRACE_MINUTES } from "@/lib/schemas/settings";
import { updateAppSettings } from "./actions";

/**
 * P7-37 — one number, and the sentence explaining what it does to everybody.
 *
 * The explanatory text is longer than the control, deliberately. An admin
 * setting this has to understand that it is company-wide and read on every
 * punch, because the failure mode of not understanding it is quietly switching
 * lateness reporting off for the whole company with a plausible-looking number.
 */
export function SettingsForm({ graceMinutes }: { graceMinutes: number }) {
  const [value, setValue] = useState(String(graceMinutes));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      setErrors({});

      // Number(""), which is 0, would silently save "exact" for an empty field.
      // NaN reaches the schema and comes back as a sentence on the field.
      const parsedValue = value.trim() === "" ? Number.NaN : Number(value);

      const result = await updateAppSettings({ grace_minutes: parsedValue });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success("Saved. New punches are judged against this from now on.");
    });
  }

  const fieldErrors = errors.grace_minutes ?? [];

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

      <Button type="submit" loading={pending}>
        Save
      </Button>
    </form>
  );
}

import { z } from "zod";

import { MAX_REMINDER_LEAD_MINUTES, MIN_REMINDER_LEAD_MINUTES } from "@/lib/preferences";

/**
 * P8-12 CONTRACT — a person's own reminder preferences.
 *
 * The D3a handoff artefact for this feature: the settings form and
 * `saveReminderPreferences` import the same object, so a bound is never written
 * twice.
 *
 * THE BOUNDS MIRROR THE CHECK CONSTRAINTS and are not the enforcement. The
 * database refuses an out-of-range lead time and a `custom` with no path too;
 * this layer exists so somebody sees a sentence under the field instead of a
 * constraint name in a toast.
 *
 * ⚠️ NEITHER `sound_key` NOR `custom_sound_path` IS IN THIS SCHEMA, and their
 * absence is the design rather than an omission.
 *
 * The path is obvious: a client that could name its own storage path could
 * point its ringtone at somebody else's object, which is the exact hole P1-09's
 * receipt handshake was built to close. `uploadReminderSound` decides it from
 * the bytes it actually received.
 *
 * THE KEY IS THE INTERESTING ONE. It looks like an ordinary radio button, and
 * making it one strands files: the CHECK constraint pairs `sound_key = 'default'`
 * with a null path, so "go back to the chime" nulls the column — and the
 * uploaded object is then unreachable, unreferenced and swept by nothing. So
 * the pair is owned exclusively by the two actions that can keep the row and
 * the bucket in step: `uploadReminderSound` sets it, `removeReminderSound`
 * clears it AND deletes the object. Uploading is choosing; choosing the default
 * is removing. There is no third operation for a form to get wrong.
 */
export const userPreferencesSchema = z.object({
  clock_in_reminder: z.boolean(),
  clock_out_reminder: z.boolean(),

  reminder_lead_minutes: z
    .number({ error: "Enter a number of minutes." })
    .int("Whole minutes only.")
    .min(
      MIN_REMINDER_LEAD_MINUTES,
      "At least one minute. A reminder at the scheduled time is a report, not a warning.",
    )
    .max(
      MAX_REMINDER_LEAD_MINUTES,
      "Two hours is the ceiling. Further ahead than that and it stops being about this shift.",
    ),

  sound_volume: z
    .number({ error: "Enter a volume." })
    .int("Whole percent only.")
    .min(0, "That cannot be negative.")
    .max(100, "100 is the loudest."),
});

export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;

import { z } from "zod";

/**
 * P7-37 CONTRACT — the company-wide settings row.
 *
 * One field so far. The schema exists as its own file anyway because the
 * settings table is deliberately typed rather than key/value: each setting gets
 * a column, a zod member and a form control, and keeping them together is what
 * stops the next one being added as an untyped string somewhere.
 *
 * THE BOUNDS MIRROR THE CHECK CONSTRAINT and are not the enforcement. The
 * database refuses 0–120 out of range too; this layer exists so an admin sees a
 * sentence on the field instead of a constraint name in a toast.
 */

export const MAX_GRACE_MINUTES = 120;

export const appSettingsSchema = z.object({
  /**
   * How far either side of a scheduled time a punch may land before the DTR
   * treats it as a deviation worth reporting.
   *
   * ZERO IS LEGAL AND MEANS EXACT — it is a real policy, not a disabled state,
   * so it must not be coerced away. There is no "off" value: turning lateness
   * prompts off for a person is done by clearing their work hours, which is a
   * fact about them rather than a company-wide policy.
   */
  grace_minutes: z
    .number({ error: "Enter a number of minutes." })
    .int("Whole minutes only.")
    .min(0, "That cannot be negative. Zero means the scheduled time exactly.")
    .max(
      MAX_GRACE_MINUTES,
      "Two hours is the ceiling. A grace period longer than that is a different schedule, not a tolerance.",
    ),
});

export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

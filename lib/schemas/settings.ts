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

/** P8-05. Eight hours — the CHECK on `break_minutes` says the same. */
export const MAX_BREAK_MINUTES = 480;

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

  /**
   * P8-05 — the unpaid break inside the scheduled day.
   *
   * Recorded hours are measured against `work_end - work_start - this`, so it
   * is what turns an 08:00–17:00 span into the eight-hour day everybody
   * actually means by it. A person who takes a different break gets their own
   * figure on their staff record; this is what everyone else inherits.
   *
   * ZERO IS LEGAL AND MEANS NO UNPAID BREAK. The ceiling of eight hours is a
   * typo guard rather than a policy: a break longer than the day it sits inside
   * makes every schedule in the company compute to nothing, which would switch
   * the shortfall check off for everybody without anybody noticing.
   */
  break_minutes: z
    .number({ error: "Enter a number of minutes." })
    .int("Whole minutes only.")
    .min(0, "That cannot be negative. Zero means no unpaid break.")
    .max(
      MAX_BREAK_MINUTES,
      "Eight hours is the ceiling. A break longer than a working day leaves no working day to measure.",
    ),
});

export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

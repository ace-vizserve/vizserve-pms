import { z } from "zod";

/**
 * P7-35 CONTRACT — the holiday calendar.
 *
 * `vizserve_pms_holidays` has existed since P4, seeded with 2026's regular
 * Philippine holidays and editable by nothing but a migration. That was fine
 * while it fed one thing (the client-approval deadline). It is not fine now:
 *
 *   - Movable holidays are PROCLAIMED ANNUALLY. Eid, and every special
 *     non-working day, arrives by proclamation on the government's schedule and
 *     not on ours. 2027 needs a list nobody has yet.
 *   - `vizserve_pms_leave_days` (P7-33) counts working days, so what is in this
 *     table now decides how many days of leave a request consumes — and
 *     therefore what the December audit says somebody has left.
 *
 * So an admin edits it, and every signed-in person sees the result on the shared
 * calendar. The RLS on the table already said exactly that — readable by any
 * active user, writable by an admin — which is why this needs no migration.
 *
 * ⚠️ EDITING A PAST HOLIDAY REWRITES HISTORY, and this is the one genuinely
 * dangerous thing about making the table editable. Leave usage is computed on
 * every read rather than stored (D27), so removing a holiday from a year that
 * has closed silently increases everybody's used days for that year and the
 * audit PDF stops matching the copy that was filed. Nothing here blocks it —
 * a wrongly-entered date has to be fixable — but the screen says so plainly and
 * every change is written to the audit log.
 */

/**
 * `YYYY-MM-DD`, and bounded to the same window as a leave allocation.
 *
 * The regex rather than `z.iso.date()` alone: this value is compared as a STRING
 * everywhere downstream — the calendar decides which cell a holiday lands in
 * with `span.start <= day`, which only works because the format sorts
 * lexicographically. A value that parsed as a date but carried a time would
 * break that silently.
 */
export const holidayDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-01-01.")
  .refine(
    (value) => {
      const year = Number(value.slice(0, 4));
      return year >= 2020 && year <= 2100;
    },
    { message: "Pick a year between 2020 and 2100." },
  )
  // Catches 2027-02-31, which the regex happily accepts. Rebuilt and compared
  // rather than merely parsed, because `Date` rolls an impossible day forward
  // into the next month instead of failing.
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
    { message: "That date does not exist." },
  );

/**
 * The name people read on the calendar.
 *
 * Capped at 80 because it renders in a calendar cell a little over an inch
 * wide. Longer than that is a paragraph, and the cell truncates it anyway —
 * better to refuse it while somebody can still shorten it themselves.
 */
export const holidayNameSchema = z
  .string()
  .trim()
  .min(1, "Give the holiday a name.")
  .max(80, "Keep it under 80 characters — it has to fit a calendar cell.");

export const createHolidaySchema = z.object({
  holiday_date: holidayDateSchema,
  name: holidayNameSchema,
});

export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;

/**
 * Rename only.
 *
 * THE DATE IS THE PRIMARY KEY, and it is absent here for the same reason
 * `updateUserSchema` has no email: changing it is not an edit, it is a different
 * holiday. Allowing it would mean a delete and an insert wearing an update's
 * clothes, and the audit row would say "renamed" about a date that moved. Moving
 * a wrongly-entered date is exactly that — delete, then add.
 */
export const updateHolidaySchema = z.object({
  holiday_date: holidayDateSchema,
  name: holidayNameSchema,
});

export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;

export const deleteHolidaySchema = z.object({
  holiday_date: holidayDateSchema,
});

/** Which year the screen is listing. Same bounds as the date above. */
export const holidayYearSchema = z.coerce
  .number({ message: "Enter a year." })
  .int("Enter a four-digit year.")
  .min(2020, "Before 2020 is out of range.")
  .max(2100, "After 2100 is out of range.");

/**
 * Is this date in a year that has already closed?
 *
 * Used to decide whether the editor shows its warning. YEAR granularity, not
 * "before today": editing next week's holiday changes a leave count for leave
 * nobody has taken yet, which is ordinary maintenance. Editing LAST YEAR's
 * changes a figure that has already been reported and possibly paid, which is
 * the thing worth stopping to read a sentence about.
 */
export function isClosedYear(holidayDate: string, currentYear: number): boolean {
  return Number(holidayDate.slice(0, 4)) < currentYear;
}

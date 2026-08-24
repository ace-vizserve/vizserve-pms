import { z } from "zod";

/**
 * P7-33 CONTRACT — leave allocations.
 *
 * The handoff artefact for the balance work (D3a). One shape, deliberately
 * small, because the interesting decisions live in SQL rather than here:
 *
 *   - `vizserve_pms_leave_balances` stores ONLY what HR allocated.
 *   - Usage is computed from approved requests by
 *     `vizserve_pms_leave_balance_summary`, never stored and never sent here.
 *
 * So there is nothing in this file about "used" or "remaining", and adding one
 * would mean a client had started calculating an entitlement figure — which is
 * the drift the whole design exists to prevent. If a screen needs those numbers
 * it calls the summary function, which is the single authority on them.
 *
 * See D27 in docs/00-README.md for why balances exist at all, given that Phase 5
 * shipped a build-failing test to keep them out.
 */

/**
 * Blank becomes NaN, which `z.number()` refuses.
 *
 * THE TRAP THIS EXISTS FOR: `Number("")` is 0, and `Number("   ")` is 0 too. A
 * bare `z.coerce.number()` therefore reads an empty box as a deliberate "zero
 * days" and writes it over somebody's entitlement — a wrong figure that looks
 * like a decision. The editor already filters blanks out before submitting;
 * this is the wall behind that, because the editor is one caller and this
 * schema is the contract.
 *
 * NaN rather than `undefined`: undefined would make the field optional, and an
 * allocation that silently does not save is the same failure one step quieter.
 */
const blankToNaN = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? Number.NaN : value;

/**
 * Half days, matching what a leave request can actually consume: P7-16 lets
 * leave start or end at midday, so an allocation of 12.5 is meaningful and one
 * of 12.3 is a typo. The same rule is a CHECK constraint on the table — this
 * copy exists to produce a sentence instead of a constraint name.
 *
 * `z.coerce` because every one of these arrives from a number input as a string.
 */
export const allocatedDaysSchema = z.preprocess(
  blankToNaN,
  z.coerce
    .number({ message: "Enter a number of days." })
    .min(0, "Days cannot be negative.")
    .max(366, "That is more days than there are in a year — check the figure.")
    .refine((value) => Number.isInteger(value * 2), {
      message: "Use whole or half days, e.g. 12 or 12.5.",
    }),
);

/**
 * The year an allocation covers.
 *
 * Bounded rather than open: a mistyped 2062 would create an allocation nobody
 * can find and that no request will ever be measured against, and the failure
 * would look like "the number I set did not save".
 */
export const balanceYearSchema = z.preprocess(
  blankToNaN,
  z.coerce
    .number({ message: "Enter a year." })
    .int("Enter a four-digit year.")
    .min(2020, "Before 2020 is out of range.")
    .max(2100, "After 2100 is out of range."),
);

/**
 * What the editor submits: the whole set for one person and one year.
 *
 * WHOLESALE, NOT A DIFF, for the reason `replaceManagedDepartments` gives about
 * managed departments — the set is at most a dozen rows, and a diff that drops
 * an update leaves somebody holding an allowance they were meant to lose. Here
 * the action upserts every row it is given rather than deleting first, since an
 * allocation of zero is a real statement and deleting the row would lose it.
 */
export const setLeaveAllocationsSchema = z.object({
  user_id: z.uuid(),
  balance_year: balanceYearSchema,
  allocations: z
    .array(
      z.object({
        leave_type_id: z.uuid(),
        days_allocated: allocatedDaysSchema,
      }),
    )
    .max(64, "Too many leave types in one save."),
});

export type SetLeaveAllocationsInput = z.infer<typeof setLeaveAllocationsSchema>;

/**
 * Half days rendered the way people say them: "12.5 days", "1 day", "half a
 * day". `toLocaleString` rather than `toFixed(1)` so a whole number reads as
 * "12" and not "12.0" — a trailing zero on every figure makes a list of
 * allocations look like a spreadsheet export.
 */
export function formatDays(value: number): string {
  const days = value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${days} ${Math.abs(value) === 1 ? "day" : "days"}`;
}

/**
 * The bare figure, for a column whose heading already says "days".
 *
 * Separate from `formatDays` rather than a flag on it: in a sentence the unit
 * has to be there ("3 days left"), and in a right-aligned column of figures it
 * must not be, because repeating it on every line is what stops the decimal
 * points from being the thing the eye follows.
 */
export function formatDayCount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/**
 * The current year in Manila.
 *
 * Not `new Date().getFullYear()`: on 1 January the server is still in December
 * for eight hours, and the admin screen would default to allocating last year.
 * The summary function applies exactly the same rule in SQL.
 *
 * No date library (a project rule) and no helper in `lib/dates.ts` returns a
 * year, so this reads it off the ISO date `todayInAppZone` already produces.
 */
export function currentBalanceYear(todayInAppZone: string): number {
  return Number(todayInAppZone.slice(0, 4));
}

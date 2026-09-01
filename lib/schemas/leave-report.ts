import { z } from "zod";

import { balanceYearSchema } from "@/lib/schemas/leave-balances";
/**
 * Named for holidays, reused here on purpose rather than copied. It is the only
 * `YYYY-MM-DD` validator in the codebase that also rejects 31 February —
 * `Date` rolls an impossible day forward into the next month instead of
 * failing, so a naive parse accepts it — and it bounds the year to the same
 * 2020–2100 window `balanceYearSchema` uses, which is what keeps the two modes
 * agreeing about which years exist.
 */
import { holidayDateSchema as calendarDateSchema } from "@/lib/schemas/holidays";

/**
 * P7-53 — the contract for the leave audit's two modes and four filters.
 *
 * The handoff artefact for this slice (D3a): the builder screen produces one of
 * these, `exportLeaveReport` consumes it, and the shape of the RPC call is
 * derived from `mode` rather than from a flag either side has to remember.
 *
 * ⚠️ A DISCRIMINATED UNION, NOT AN OBJECT WITH OPTIONAL DATES. The two modes
 * genuinely disagree about what a period IS — Mode A audits a calendar YEAR
 * against an annual allocation, Mode B counts leave inside an ARBITRARY window
 * and has no allocation to report. A single object carrying `year?`, `from?`
 * and `to?` would make "annual with a from-date" and "taken with a year"
 * representable, and both are meaningless. The union makes them unspellable.
 */

/**
 * One filter list.
 *
 * ⚠️ `undefined` MEANS NO FILTER; `[]` IS REFUSED. Both functions in P7-53 read
 * a null array as "everything in scope", so passing an empty array through
 * would not mean "no filter" — it would mean "match nothing" and render a PDF
 * with a header, a footer and no rows. That document is indistinguishable from
 * a broken export, and it is an audit document, so somebody would go looking
 * for the bug in the wrong place. An empty selection is a mistake at the UI, so
 * it is caught here rather than printed.
 */
const filterIds = z
  .array(z.uuid())
  .min(1, "Pick at least one, or clear the filter entirely.")
  .max(200, "That is too many to filter by — narrow it another way.")
  .optional();

const sharedFilters = {
  userIds: filterIds,
  departmentIds: filterIds,
  leaveTypeIds: filterIds,
};

export const leaveReportFilterSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("annual"),
    /** Reused from P7-33 so the report and the balances grid bound years alike. */
    year: balanceYearSchema,
    ...sharedFilters,
  }),
  z
    .object({
      mode: z.literal("taken"),
      from: calendarDateSchema,
      to: calendarDateSchema,
      ...sharedFilters,
    })
    /**
     * Checked here as well as in SQL, and deliberately in both places. The
     * function raises `check_violation` for a backwards range because it is the
     * last line of defence; this one exists so the person gets a sentence under
     * the field instead of a Postgres error code in a toast.
     */
    .refine((value) => value.to >= value.from, {
      message: "The end date cannot be before the start date.",
      path: ["to"],
    }),
]);

export type LeaveReportFilterInput = z.infer<typeof leaveReportFilterSchema>;
export type LeaveReportMode = LeaveReportFilterInput["mode"];

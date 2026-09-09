import { z } from "zod";

/**
 * P12-20 — THE SHAPES BEHIND `qk.ref(...)`, in one file.
 *
 * ------------------------------------------------------------------------
 * ⚠️ REFERENCE DATA IS THE ONE CATEGORY WHERE THE ROW SET IS SHARED AND THE
 * QUESTION IS NOT. Seven tables, one `["ref", …]` prefix, ten-minute
 * `REF_STALE_TIME` — and a dozen consumers that each want a DIFFERENT SUBSET of
 * the same rows. The rule this file encodes, learned on `qk.ref("users")` in
 * P12-07 and applied to the rest here:
 *
 *   THE FETCHER READS THE WHOLE TABLE. THE CONSUMER FILTERS.
 *
 * ⚠️ AND THE REASON IS NOT TIDINESS, IT IS THAT NAMES MUST STILL RESOLVE. A
 * picker wants the ACTIVE rows, because offering a retired department or a
 * deactivated colleague is offering a door the server does not open. But a
 * TABLE wants every row, because the department a two-year-old task belongs to
 * may since have been retired, and a report that cannot name it prints
 * "Another department" over a figure somebody is about to act on. Filter in the
 * query and the second consumer silently loses rows; filter in the consumer and
 * both are right.
 *
 * ⚠️ SO `is_active` IS A COLUMN ON EVERY SHAPE BELOW, NEVER A `.eq()` IN THE
 * QUERY. `lib/query/fetchers/ref.ts` says the same thing at each fetcher, and
 * `fetchDirectory`'s comment in `fetchers/task.ts` is the original statement of
 * it. A consumer that offers somebody or something a SEAT must test this column
 * itself — and must anyway, because it is invariably narrowing by department in
 * the same pass.
 * ------------------------------------------------------------------------
 */

/**
 * `qk.ref("departments")` — ONE DEPARTMENT, ACTIVE OR NOT.
 *
 * ⚠️ `is_active` ARRIVED WITH P12-20 AND THE QUERY FILTER CAME OFF WITH IT — a
 * widening, on purpose, and the exact move P12-07 made on the staff directory.
 * `fetchDepartments` had one consumer (`new-task-button.tsx`, the create
 * picker) and read `is_active = true`; Phase 6 added four more that need the
 * NAME of a department rather than a seat in it — `/reports` labels every bar
 * and table row with it, `/forms` labels the Department column, `/hr/reports`
 * offers it as an audit filter. Narrowed to the active, a retired department's
 * tasks would have printed under "Another department" on a page whose whole
 * purpose is to be added up.
 *
 * ⚠️ SO THE CREATE PICKER FILTERS `is_active` ITSELF NOW, and it must:
 * `vizserve_pms_create_task` refuses a retired department, so offering one is
 * offering a door the server does not open. It was already narrowing to
 * `managedDepartmentIds` in the same pass, so this is one more clause in a
 * filter that existed.
 */
export const departmentOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  is_active: z.boolean(),
});

export type DepartmentOption = z.infer<typeof departmentOptionSchema>;

/**
 * `qk.ref("leave-types")` — ONE LEAVE TYPE, LIVE OR RETIRED.
 *
 * ⚠️ RETIRED TYPES ARE IN THIS SET DELIBERATELY, and `/hr/reports` is why:
 * filtering an audit TO a withdrawn type is precisely the question that report
 * exists to answer — what was taken under a type HR retired in March. The page
 * read them unfiltered before this key existed and it still must.
 *
 * ⚠️ AND THE FILING PICKER MUST NOT USE THIS ENTRY. `fetchFilingOptions`
 * (`fetchers/approvals.ts`) reads its own `is_active = true, order by
 * sort_order` set under `qk.approvals(...)`, together with the caller's
 * balances and their reliever candidates, because those three are read and
 * refetched as one thing after every decision. It stayed there: offering a
 * retired type on a NEW request is the one thing this table's `is_active`
 * column exists to prevent, and the two row sets are therefore not a subset
 * either way round — the same argument `qk.listsManaged()` makes against
 * reusing `qk.listsVisible()`.
 *
 * `sort_order` rides along so a consumer that wants HR's ordering — Vacation
 * and Sick first, because that is what almost everybody picks — can have it
 * without a second read.
 */
export const leaveTypeOptionSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  sort_order: z.number(),
  is_active: z.boolean(),
});

export type LeaveTypeOption = z.infer<typeof leaveTypeOptionSchema>;

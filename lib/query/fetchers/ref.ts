import { parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  departmentOptionSchema,
  leaveTypeOptionSchema,
  type DepartmentOption,
  type LeaveTypeOption,
} from "@/lib/schemas/reference";

import type { TaskReadClient } from "./task";

/**
 * P12-20 — EVERY `qk.ref(...)` READ, IN ONE PLACE.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT THIS REPLACES, AND WHAT IT COST BEFORE.
 *
 * Reference data is the cheapest win in the SPA migration and it is cheap for
 * an unflattering reason: nearly every page re-read the same four tables from
 * scratch. The departments table alone was read by `/reports`, `/forms`,
 * `/forms/new`, `/forms/[id]`, `/hr/reports` and `/tasks` — six independent
 * round trips for a list of about six rows that changes about once a quarter,
 * re-issued on every navigation because each read lived inside a Server
 * Component and `revalidatePath` has no unit smaller than a route. The staff
 * directory was read on `/hr/reports`, `/forms/[id]` (responses) and three task
 * surfaces. None of it is per-user, none of it is time-sensitive, and all of it
 * was being fetched as though it were both.
 *
 * ⚠️ `REF_STALE_TIME` IS TEN MINUTES AND IT IS WHY THIS PREFIX EXISTS.
 * `lib/query/client.ts` declares it; every consumer below passes it. So a tab
 * reads the departments ONCE and the next five screens that want them pay
 * nothing at all.
 *
 * ⚠️ AND A LONG STALE TIME MAKES THE INVALIDATION ROW MANDATORY RATHER THAN A
 * NICETY. `lib/query/realtime.ts` maps `vizserve_pms_task_groups` to
 * `qk.ref("task-groups")` for exactly this reason — without it a renamed folder
 * would keep its old name in the filter dropdown for the rest of the session.
 * Anything added to this file that a person can EDIT from inside the app needs
 * either a row in that map or an explicit invalidation from the screen that
 * edits it. `vizserve_pms_forms` is the case that has neither: it is not
 * published to Realtime, so `/forms` invalidates `qk.ref("client-forms")` from
 * its own mutations (see `app/(app)/forms/forms-view.tsx`).
 *
 * ⚠️ THE HOUSE RULE FOR EVERY FETCHER HERE: READ THE WHOLE TABLE, LET THE
 * CONSUMER FILTER. `lib/schemas/reference.ts` argues it at length and
 * `fetchDirectory` below is the original case. A picker wants the active rows;
 * a table wants every row so old names still resolve. Filtering in the query
 * serves the first and silently breaks the second.
 *
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER AND NOTHING HERE MAY START TO. All of
 * these are RLS-scoped — a lead reading the directory gets the people they
 * lead, an owner gets everyone, from the same query. Where a screen needs a
 * NARROWER offer than the policy returns (the department a form may be routed
 * to, say) that narrowing is a SEAT, is computed on the server beside
 * `requireAuthContext()`, and arrives at the consumer as a prop.
 * ------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* The four that already existed, re-exported so there is one place to look.   */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ RE-EXPORTS, NOT SHIMS, AND THE BODIES DELIBERATELY DID NOT MOVE. Each of
 * these three lives beside the surface that argues hardest for its shape —
 * `fetchDirectory` beside the task detail page whose comment authors it has to
 * name, `fetchTaskFolders` beside the filter panel, `fetchClientForms` beside
 * the request queue whose dropdown it fills — and each carries several
 * paragraphs of reasoning at its definition. Moving the code would have moved
 * those comments away from the callers they were written for and left three
 * files importing across the phase boundary anyway. The same trade `task.ts`
 * makes when it re-exports `fetchRequestDetail` from `requests.ts`.
 *
 *   `qk.ref("users")`        → `fetchDirectory` — the WHOLE directory, active
 *                              and not. P12-07 took the `is_active` filter off
 *                              on purpose; do not put it back.
 *   `qk.ref("task-groups")`  → `fetchTaskFolders` — P7-18, the folder list.
 *   `qk.ref("client-forms")` → `fetchClientForms` — CLIENT_REQUEST forms only,
 *                              which is a purpose filter and not a department
 *                              filter in disguise.
 */
export { fetchDirectory } from "./task";
export { fetchTaskFolders } from "./task-list";
export { fetchClientForms } from "./requests";
export type { DirectoryPerson } from "@/lib/schemas/task-list";
export type { RequestForm } from "@/lib/schemas/requests";
export type { TaskFolder } from "@/lib/schemas/task-list";

/* -------------------------------------------------------------------------- */
/* The two Phase 6 added.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `qk.ref("departments")` — EVERY DEPARTMENT IN SCOPE, ACTIVE OR NOT.
 *
 * ⚠️ THIS FUNCTION MOVED HERE FROM `fetchers/task-list.ts` AND WAS WIDENED ON
 * THE WAY, and the widening is the interesting half. It read
 * `.eq("is_active", true)` while it had ONE consumer — the create-task
 * department picker, which offers a seat. Phase 6 gave it four more, and every
 * one of them wants the NAME of a department rather than a seat in it:
 *
 *   `/reports`     labels every bar, every table row and every hours figure.
 *   `/forms`       labels the Department column of the forms table.
 *   `/hr/reports`  offers departments as a filter on an AUDIT document.
 *   `/forms/[id]`  names the department a form is routed to.
 *
 * A retired department still owns the tasks it owned, the forms it owned and
 * the leave that was taken in it. Narrowed to the active, `/reports` would have
 * printed those rows under "Another department" — its own fallback for a
 * department the POLICY withheld — which is a sentence about permissions
 * standing over a figure whose real problem was a checkbox in `/admin`. That is
 * the same confusion `submissionsReadable` exists to prevent on `/forms`, just
 * arrived at from the other side.
 *
 * ⚠️ SO THE CREATE PICKER FILTERS `is_active` FOR ITSELF NOW. It must:
 * `vizserve_pms_create_task` refuses a retired department, so offering one is
 * offering a door the server does not open — the same rule `fetchDirectory`
 * states for a deactivated colleague. It was already narrowing the offer to
 * `managedDepartmentIds`, so this is one more clause in a filter that existed
 * rather than a new burden.
 *
 * ⚠️ AND STILL NO ROLE FILTER. RLS returns what the reader may see; the caller
 * narrows for the OFFER. Restating the scope in SQL would imply the policy were
 * optional (CLAUDE.md).
 */
export async function fetchDepartments(client: TaskReadClient): Promise<DepartmentOption[]> {
  const rows = await read<unknown[]>(
    client.from("vizserve_pms_departments").select("id, name, is_active").order("name"),
  );

  return parseAll(departmentOptionSchema, rows, "departments");
}

/**
 * `qk.ref("leave-types")` — EVERY LEAVE TYPE, LIVE OR RETIRED.
 *
 * ⚠️ ONE CONSUMER TODAY AND IT IS THE ONE THAT NEEDS THE RETIRED ONES:
 * `/hr/reports`, where filtering an audit TO a withdrawn type is exactly the
 * question the report exists to answer. The page read them unfiltered before
 * this key existed and the key had to be able to hold that, so — as everywhere
 * else in this file — the whole table comes back and `is_active` rides along as
 * a column for anybody who needs to grey a row.
 *
 * ⚠️ AND THE FILING PICKER DOES NOT SHARE THIS ENTRY, DELIBERATELY.
 * `fetchFilingOptions` in `fetchers/approvals.ts` reads `is_active = true`
 * ordered by `sort_order`, bundled with the caller's balances and their
 * reliever candidates under `qk.approvals(...)`, because those three are read
 * and refetched together after every decision. Two things keep it there:
 * offering a retired type on a NEW request is the one thing that column exists
 * to prevent, and it also selects `applies_to_gender` and `requires_reliever`,
 * which are rules about who may file rather than labels on a report. So the two
 * row sets are not a subset either way round — the same test `keys.ts` applies
 * to `qk.listsManaged()` against `qk.listsVisible()`.
 *
 * ⚠️ NOT IN `realtime.ts`. `vizserve_pms_leave_types` is not published to
 * Realtime, so an HR edit on `/hr/leave-types` takes up to `REF_STALE_TIME` to
 * reach an open tab. That is acceptable HERE and stated rather than assumed:
 * the only reader is a filter list on a report somebody is about to export, a
 * type retired ten minutes ago still has every one of its historical absences,
 * and `/hr/leave-types` is a server-rendered screen by settled decision 5, so
 * it has no cache to invalidate from.
 */
export async function fetchLeaveTypes(client: TaskReadClient): Promise<LeaveTypeOption[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_leave_types")
      .select("id, label, sort_order, is_active")
      /*
       * HR's own ordering, not alphabetical: the seed puts Vacation and Sick
       * first because that is what almost everybody picks, and a consumer that
       * wants A–Z can sort what it was given. `label` breaks the tie so two
       * types sharing a sort order do not come back in whatever order the
       * planner chose today — a filter list that reshuffles between renders
       * looks broken even when it is not.
       */
      .order("sort_order")
      .order("label"),
  );

  return parseAll(leaveTypeOptionSchema, rows, "leave types");
}

/**
 * ⚠️ `qk.ref("holidays")` AND `qk.ref("events")` HAVE NO FETCHER HERE, AND THAT
 * IS A FINDING RATHER THAN AN OVERSIGHT.
 *
 * Both keys are declared in `RefTable` and both tables are read in this app —
 * but every reader of either is on a surface that STAYS SERVER-RENDERED.
 * Holidays: `/admin/holidays`, `/hr/attendance`, and `lib/timesheet-schedule-
 * server.ts`. Events: `/admin/events`. The only other reader of either is the
 * dashboard at `app/page.tsx`, which no phase of this migration converts.
 *
 * Writing two fetchers nothing calls would put unread queries in the bundle and
 * would freeze a shape before the screen that needs it exists — and the shape
 * is the part that is hard to get right, as `qk.lists(departmentId)` records at
 * length in `keys.ts`. The KEYS are already there for whoever converts the
 * dashboard; the plumbing under them is not the expensive part.
 */

export type { DepartmentOption, LeaveTypeOption };

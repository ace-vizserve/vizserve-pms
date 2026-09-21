import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

/**
 * The department reads that half the app opens with.
 *
 * ⚠️ THERE ARE THREE QUESTIONS HERE, NOT ONE ASKED ELEVEN TIMES, and the
 * difference between the first two is the thing most likely to be "tidied" into
 * a bug:
 *
 *   - `loadActiveDepartments` fills a PICKER. Only active departments, because
 *     offering an archived one is offering to file new work into a queue nobody
 *     reads.
 *   - `loadDepartmentNames` resolves a NAME ALREADY ON A ROW. Every department,
 *     archived included — a task filed last year still belongs to the
 *     department it was filed under, and dropping archived ones here renders
 *     historic rows with a blank where their department should be.
 *   - `loadManagedDepartmentNames` is the rail's "you lead X and Y" line.
 *
 * So the `is_active` filter disagreeing between call sites was NOT the drift it
 * looked like. What was genuinely duplicated is the query, the ordering and the
 * `id -> name` Map, written out in eleven places — and the ordering had already
 * drifted once (`sidebar-panel.tsx` records that it disagreed with
 * `/tasks/lists` about `sort_order`).
 *
 * ⚠️ `cache()`d, and that is most of the point. `sidebar-panel.tsx` renders on
 * EVERY page and reads departments, so it ran alongside the page's own copy on
 * /timesheet, /reports, /hr/attendance, /admin/users and the rest — two
 * identical reads per render, every navigation.
 *
 * ⚠️ NO SCOPE FILTER IN ANY OF THEM. `vizserve_pms_departments` is readable by
 * every signed-in user; which departments somebody may ACT on is
 * `lib/auth/authorization.ts`'s question, and callers narrow with
 * `departmentPickerScope` and friends after the fact. Answering it here would
 * put a second authorization layer in a reference read — the thing CLAUDE.md
 * says must never be scattered.
 */

export type Department = { id: string; name: string };

/** Active departments, by name. For any picker that files NEW work. */
export const loadActiveDepartments = cache(async (): Promise<Department[]> => {
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  return data ?? [];
});

/**
 * Every department as `id -> name`, archived included.
 *
 * The lookup behind a location line, a report row, a filter label. An archived
 * department is still the department a historic row was filed under.
 */
export const loadAllDepartments = cache(async (): Promise<Department[]> => {
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .order("name");

  return data ?? [];
});

/**
 * The same set as a lookup, for the sites that only ever ask "what is this one
 * called". Built on the array above, so the two are one round trip.
 */
export const loadDepartmentNames = cache(async (): Promise<Map<string, string>> => {
  return new Map((await loadAllDepartments()).map((row) => [row.id, row.name]));
});

/**
 * P13-01 — the COLLABORATION SPACES: departments flagged `is_shared`, which
 * every active person belongs to rather than nobody.
 *
 * ⚠️ A QUERY OF ITS OWN RATHER THAN A COLUMN ON `loadActiveDepartments`, AND
 * THAT IS THE WHOLE POINT OF THIS FUNCTION EXISTING. Migrations in this repo are
 * pasted by hand AFTER the code is deployed (`resolveAuth`'s note on
 * `deptAdminColumnMissing` is the long version). PostgREST rejects a select
 * naming an unknown column WHOLE — not the column, the request — so adding
 * `is_shared` to the loader above would mean that between the deploy and the
 * paste, every department picker and the entire project tree came back empty.
 *
 * Asked separately, a failure costs exactly this feature and nothing else: the
 * set is empty, no department is shared, and the app behaves precisely as it did
 * before P13-01. Which is also the truth at that moment. Same reasoning, same
 * shape, as `loadMustChangePassword`.
 *
 * `is_active` is tested here as well as in `vizserve_pms_shared_department_ids()`
 * — archiving the space is how it is switched off, and the two halves must agree
 * about that or the rail would offer a space the policies refuse.
 */
export const loadSharedDepartmentIds = cache(async (): Promise<string[]> => {
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_departments")
    .select("id")
    .eq("is_shared", true)
    .eq("is_active", true)
    .order("name");

  return (data ?? []).map((row) => row.id);
});

/**
 * P13-02 — EVERYBODY ASSIGNABLE ON COMPANY-WIDE WORK.
 *
 * ⚠️ AN RPC RATHER THAN A `from("vizserve_pms_users")` READ, AND THAT IS THE
 * WHOLE REASON THIS EXISTS. P13-01 made every active person assignable on a
 * collaboration task in the DATABASE, and the pickers still showed six names —
 * because SELECT on `vizserve_pms_users` is department-scoped (p7_17 and four
 * additive policies since). A plain read through the caller's own client
 * returns "everyone I could already see", which for a member is their own team.
 * The rule had landed and the screen had not.
 *
 * `vizserve_pms_collaborators()` is `security definer` and reads past that. It
 * is a FUNCTION rather than a widened policy on purpose: a permissive policy is
 * OR-ed into every query in the app, so one clause admitting "everybody, because
 * a shared space exists" would end department scoping on people everywhere —
 * the DTR filter, the HR screens, the reports. A function has call sites, and
 * these are them.
 *
 * ⚠️ CALL IT ONLY WHEN THE DESTINATION IS A SHARED DEPARTMENT. It is not a
 * general "everybody" loader and must not become one: offering somebody from
 * another department while filing into an ORDINARY list produces "That assignee
 * is not an active member of this department." after the form has been filled
 * in — the exact class of failure P13-01 §5 went to some trouble to remove.
 *
 * `?? []` on failure, like every other degrade in this file. The function does
 * not exist until the migration is pasted, and empty there means the pickers
 * behave exactly as they did before — which is the pre-migration truth.
 */
export const loadCollaborators = cache(
  async (): Promise<{ id: string; full_name: string }[]> => {
    const supabase = await createClient();

    const { data } = await supabase.rpc("vizserve_pms_collaborators");

    return data ?? [];
  },
);

/**
 * The names of the departments somebody leads, in order.
 *
 * ⚠️ EMPTY IN MEANS EMPTY OUT, WITHOUT A QUERY. `.in("id", [])` is a request
 * that can only return nothing, and this runs on every page through the rail.
 */
export const loadManagedDepartmentNames = cache(
  async (ids: readonly string[]): Promise<string[]> => {
    if (ids.length === 0) return [];

    const supabase = await createClient();

    const { data } = await supabase
      .from("vizserve_pms_departments")
      .select("name")
      .in("id", ids)
      .order("name");

    return (data ?? []).map((row) => row.name);
  },
);

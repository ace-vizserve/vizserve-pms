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

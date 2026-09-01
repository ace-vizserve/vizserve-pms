import "server-only";

import { departmentPickerScope } from "@/lib/auth/authorization";
import type { AuthContext } from "@/lib/auth/authorization";
import type { createClient } from "@/utils/supabase/server";

/** What the department `<Select>` on the settings card renders. */
export type RoutableDepartment = { id: string; name: string };

export type RoutableDepartments = {
  departments: RoutableDepartment[];
  /** `null` when the list is trustworthy — INCLUDING when it is empty. */
  error: { message: string } | null;
};

/**
 * P7-66 — the departments this person may route a form to.
 *
 * ⚠️ "LEADS NOTHING" IS AN EMPTY LIST, NOT A FAILED READ, and telling the two
 * apart is the entire job here. Both callers used to narrow with
 * `.in("id", [""])` when `managedDepartmentIds` was empty — a sentinel that
 * always errors (`invalid input syntax for type uuid: ""`), which was harmless
 * only while the error was being thrown away. /forms/[id] now groups a
 * departments failure with the reads that must not open the builder, so the
 * sentinel turned a reachable state — a team leader with no department mapping,
 * opening the unrouted form they just created — into a hard page failure.
 *
 * `departmentPickerScope` answers `none` for that person and NO QUERY IS SENT,
 * so there is no error to confuse with a real one. A genuine failure — a dropped
 * connection, a policy fault — still comes back in `error` and stays loud: an
 * empty department list is not cosmetic, because saving the settings card writes
 * what it shows.
 *
 * Shared by /forms/new and /forms/[id] rather than written twice. The bug was in
 * both, and a second copy is a second place to fix it next time.
 */
export async function loadRoutableDepartments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  context: AuthContext,
): Promise<RoutableDepartments> {
  const scope = departmentPickerScope(context);

  if (scope.kind === "none") return { departments: [], error: null };

  const query = supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .eq("is_active", true);

  // An admin routes anywhere; everyone else is limited to what they lead, so
  // the selector cannot be used to hand work to a queue they do not own.
  if (scope.kind === "some") query.in("id", scope.ids);

  const { data, error } = await query.order("name");

  return { departments: data ?? [], error };
}

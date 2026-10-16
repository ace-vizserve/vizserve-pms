/**
 * P17-01 — A PERSON'S DEPARTMENTS: the MAIN one, plus any SUB departments.
 *
 * `primary_department_id` is the main department: where their approvals go and
 * which reports count them. A SUB department (`vizserve_pms_user_departments`)
 * is the task side of membership only — read, edit, be assigned, log time. So
 * every "is this person in the task's department?" asked by a task screen goes
 * through here, and nothing about approvals, DTR, leave or timesheets does.
 *
 * ⚠️ THIS IS THE BUTTON, NEVER THE GATE. `vizserve_pms_is_department_member`
 * answers the same question in the database, and RLS is the enforcement.
 *
 * No `server-only` import: the pickers run in the browser.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

export type DepartmentHolder = {
  primary_department_id: string | null;
  /** Absent before the migration, and for anybody who has none. */
  sub_department_ids?: readonly string[];
};

/** Main first, then subs. Empty for somebody with no department at all. */
export function departmentsOf(person: DepartmentHolder): string[] {
  const ids = person.primary_department_id ? [person.primary_department_id] : [];
  for (const id of person.sub_department_ids ?? []) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function belongsToDepartment(person: DepartmentHolder, departmentId: string | null): boolean {
  if (!departmentId) return false;
  return (
    person.primary_department_id === departmentId ||
    (person.sub_department_ids ?? []).includes(departmentId)
  );
}

export type SubDepartmentRow = { user_id: string; department_id: string };

/** Attach each person's sub departments, read separately (see `fetchSubDepartmentRows`). */
export function withSubDepartments<T extends { id: string }>(
  people: readonly T[],
  rows: readonly SubDepartmentRow[],
): (T & { sub_department_ids: string[] })[] {
  const byUser = new Map<string, string[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id);
    if (list) list.push(row.department_id);
    else byUser.set(row.user_id, [row.department_id]);
  }
  return people.map((person) => ({ ...person, sub_department_ids: byUser.get(person.id) ?? [] }));
}

type MembershipClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

/**
 * "Is this person an active member of this department, main or sub?" — the
 * friendly refusal a reassign shows before the write. Asks
 * `vizserve_pms_is_department_member`; before the migration is pasted that
 * function does not exist, and the answer falls back to the main department,
 * which is exactly what the database enforced until then.
 */
export async function isDepartmentMember(
  client: MembershipClient,
  departmentId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("vizserve_pms_is_department_member", {
    p_department_id: departmentId,
    p_user_id: userId,
  });
  if (!error) return data === true;

  const { data: row } = await client
    .from("vizserve_pms_users")
    .select("id")
    .eq("id", userId)
    .eq("primary_department_id", departmentId)
    .eq("is_active", true)
    .maybeSingle();
  return row !== null;
}

/** The ids of a department's sub members. Empty before the migration. */
export async function subMemberIds(client: MembershipClient, departmentId: string): Promise<string[]> {
  const { data, error } = await client
    .from("vizserve_pms_user_departments")
    .select("user_id")
    .eq("department_id", departmentId);
  return error ? [] : (data ?? []).map((row) => row.user_id);
}

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { createClient } from "@/utils/supabase/server";

import { NewTaskDialog } from "./new-task-dialog";

/**
 * P3-12 — the entry point for a task with no request behind it.
 *
 * A server component so the department, people and list options are fetched
 * once with the page rather than by the dialog on every open. It renders
 * nothing at all for a member: creating work for other people is a Team Leader
 * decision, and a disabled button that explains itself is just an invitation to
 * ask why.
 */
export async function NewTaskButton() {
  const context = await requireAuthContext();

  if (!roleAtLeast(context.role, "team_leader")) return null;

  const supabase = await createClient();

  // RLS scopes all three: a TL sees the departments they lead, the people in
  // them, and those departments' lists. No `.in(...)` needed here.
  const [{ data: departments }, { data: people }, { data: lists }] = await Promise.all([
    supabase
      .from("vizserve_pms_departments")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("vizserve_pms_users")
      .select("id, full_name, primary_department_id")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("vizserve_pms_lists")
      .select("id, name, department_id")
      .eq("is_active", true)
      .order("name"),
  ]);

  // An admin sees every department; a TL should only be offered the ones they
  // actually lead, or the create call fails after they have filled in the form.
  const allowed =
    context.role === "admin"
      ? (departments ?? [])
      : (departments ?? []).filter((department) =>
          context.managedDepartmentIds.includes(department.id),
        );

  if (allowed.length === 0) return null;

  return (
    <NewTaskDialog
      departments={allowed}
      people={people ?? []}
      lists={lists ?? []}
      defaultDepartmentId={allowed[0]!.id}
    />
  );
}

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { createClient } from "@/utils/supabase/server";

import { NewPersonalTaskDialog } from "./new-personal-task-dialog";
import { NewTaskDialog } from "./new-task-dialog";

/**
 * P3-12 — the entry point for a task with no request behind it.
 *
 * A server component so the department, people and list options are fetched
 * once with the page rather than by the dialog on every open.
 *
 * TWO DIALOGS, ONE BUTTON (P7-01). Until P7-01 this component returned null for
 * a member and the entire personal-task path was unreachable from the UI.
 *
 * P7-14 MOVED THE LINE, and it is worth being exact about where it now sits.
 * Creating work for a colleague is no longer a Team Leader decision — a member
 * may do it inside their own department. What a lead still has that a member does
 * not is the CHOICE OF DEPARTMENT (any they lead) and the appointment of a QA
 * reviewer. That is the whole difference between the two dialogs now, and it is
 * why they are still two.
 *
 * The branch is on role, and the two dialogs post to two different functions
 * with two different parameter lists. A member cannot reach the TL one by
 * changing anything client-side, because `vizserve_pms_create_task` reads their
 * department off their own row and checks `vizserve_pms_manages_department`
 * itself.
 *
 * `trigger` is the SHAPE, never the permission. The board column and the list
 * group ask for their own quiet in-place version; the role check above still
 * decides whether any of them renders at all, so a new call site cannot acquire
 * a button by asking for a different look.
 */
export async function NewTaskButton({
  trigger = "toolbar",
}: {
  trigger?: "toolbar" | "column" | "row";
} = {}) {
  const context = await requireAuthContext();
  const supabase = await createClient();

  /*
   * The member path, and it returns BEFORE the team-leader fetch below.
   *
   * Both of that fetch's early returns — the role gate and
   * `allowed.length === 0` — used to swallow this case. Putting the branch
   * after either of them is how "members can create their own tasks" ships as
   * a button that never appears.
   *
   * P7-14 CHANGED WHAT THIS BRANCH NEEDS. It used to fetch only lists, because
   * department and assignee were both resolved server-side and neither was the
   * member's to choose. A member may now assign work to a colleague in their own
   * department, so the dialog needs that department and the people in it.
   *
   * THE DEPARTMENT IS READ HERE, ON THE SERVER, from the caller's own row — never
   * sent up as something the browser picked. `vizserve_pms_create_task` re-reads
   * it and refuses any other, so this is the convenient copy rather than the
   * enforcement.
   */
  if (!roleAtLeast(context.role, "team_leader")) {
    const { data: me } = await supabase
      .from("vizserve_pms_users")
      .select("primary_department_id")
      .eq("id", context.userId)
      .maybeSingle();

    const myDepartment = me?.primary_department_id ?? null;

    const [{ data: myLists }, { data: colleagues }] = await Promise.all([
      supabase.from("vizserve_pms_lists").select("id, name").eq("is_active", true).order("name"),
      // `.neq` on themselves: "Myself" is the dialog's default, not a row in the
      // list, because the two choices call two different functions and produce
      // two different `is_personal` values.
      myDepartment
        ? supabase
            .from("vizserve_pms_users")
            .select("id, full_name")
            .eq("primary_department_id", myDepartment)
            .eq("is_active", true)
            .neq("id", context.userId)
            .order("full_name")
        : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    ]);

    const dialog = (
      <NewPersonalTaskDialog
        lists={myLists ?? []}
        colleagues={colleagues ?? []}
        departmentId={myDepartment}
        trigger={trigger}
      />
    );

    if (trigger === "column") return <div className="shrink-0 px-2 pb-2">{dialog}</div>;
    if (trigger === "row") return <div className="border-t px-2 py-1.5">{dialog}</div>;
    return dialog;
  }

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

  const dialog = (
    <NewTaskDialog
      departments={allowed}
      people={people ?? []}
      lists={lists ?? []}
      defaultDepartmentId={allowed[0]!.id}
      trigger={trigger}
    />
  );

  // The wrapper belongs to the button, not to the call site. This component
  // returns null for a member, and a <div className="border-t …"> around a null
  // is a stray rule with padding under it — which is what every board column and
  // every list group grew the first time this was wrapped from outside.
  if (trigger === "column") return <div className="shrink-0 px-2 pb-2">{dialog}</div>;
  if (trigger === "row") return <div className="border-t px-2 py-1.5">{dialog}</div>;

  return dialog;
}

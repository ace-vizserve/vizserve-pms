import { loadPersonalTaskOptions } from "@/lib/personal-task-server";
import { loadActiveDepartments, loadCollaborators } from "@/lib/departments-server";
import { isCollaborationSpace, requireAuthContext } from "@/lib/auth/authorization";
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
  listId = null,
}: {
  trigger?: "toolbar" | "column" | "row";
  /**
   * The list the reader is ALREADY looking at, from `?list=` on /tasks and
   * /tasks/board.
   *
   * ⚠️ WITHOUT THIS THE DIALOG DEFAULTS TO "No list" AND THE TASK VANISHES.
   * Somebody filtered to a list, pressed New task, typed a title and pressed
   * save — and the task was filed with `list_id = NULL`, so it could not appear
   * in the list they were staring at. It looked exactly like the save had
   * failed. It had not; the task was in the unfiled pile.
   *
   * Passed down as a DEFAULT, not a lock: the picker still renders and the list
   * is still changeable, because "new task in the list I am reading" is the
   * common case and not the only one.
   */
  listId?: string | null;
} = {}) {
  const context = await requireAuthContext();
  const supabase = await createClient();

  /*
   * P11-06 — ⚠️ INSIDE A PERSONAL LIST, THE LIST DECIDES AND NOT THE RANK, WHICH
   * IS WHY THIS BRANCH COMES FIRST.
   *
   * Everything below this point branches on role: a member gets the personal
   * dialog, a team leader gets the one with a department and a QA reviewer. That
   * was complete while every list belonged to a department. It is not any more.
   *
   * A personal list holds ONLY its owner's own personal tasks — that is
   * `vizserve_pms_tasks_personal_list_guard`, and it is not negotiable. So a
   * team leader standing in their own personal list and pressing New task would
   * otherwise get `NewTaskDialog`, which posts to `vizserve_pms_create_task`,
   * which makes a non-personal task, which the trigger refuses. The rule would
   * be met as an error message after the form had been filled in.
   *
   * `colleagues` is deliberately EMPTY rather than omitted: the dialog offers
   * the assignee picker only when it has somebody to offer, so an empty array is
   * how "this can only be your own work" is expressed — which is exactly true
   * here.
   *
   * Scoped by `owner_id = context.userId` rather than by RLS alone, because the
   * question is not "may I see this list" but "is this list MINE".
   */
  if (listId) {
    const { data: personalList } = await supabase
      .from("vizserve_pms_lists")
      .select("id, name, department_id")
      .eq("id", listId)
      .eq("owner_id", context.userId)
      .maybeSingle();

    if (personalList) {
      const dialog = (
        <NewPersonalTaskDialog
          lists={[personalList]}
          colleagues={[]}
          departmentId={context.primaryDepartmentId}
          selfId={context.userId}
          trigger={trigger}
          defaultListId={personalList.id}
        />
      );

      if (trigger === "column") return <div className="shrink-0 px-2 pb-2">{dialog}</div>;
      if (trigger === "row") return <div className="border-t px-2 py-1.5">{dialog}</div>;
      return dialog;
    }
  }

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
    // ⚠️ SHARED WITH `app/_home/new-task-action.tsx`, WHICH WAS A COPY OF THIS
    // BLOCK — three queries and their comments, in two route groups. "Who may I
    // assign to" had two homes; now it has one.
    const {
      departmentId: myDepartment,
      lists: myLists,
      colleagues,
      everyone,
    } = await loadPersonalTaskOptions(context.userId);

    const dialog = (
      <NewPersonalTaskDialog
        lists={myLists}
        colleagues={colleagues}
        /* P13-01. Offered only while a collaboration list is selected -- the
           dialog decides, because only the dialog knows which list is. */
        everyone={everyone}
        sharedDepartmentIds={context.sharedDepartmentIds}
        departmentId={myDepartment}
        selfId={context.userId}
        trigger={trigger}
        defaultListId={listId}
      />
    );

    if (trigger === "column") return <div className="shrink-0 px-2 pb-2">{dialog}</div>;
    if (trigger === "row") return <div className="border-t px-2 py-1.5">{dialog}</div>;
    return dialog;
  }

  // RLS scopes all three: a TL sees the departments they lead, the people in
  // them, and those departments' lists. No `.in(...)` needed here.
  const [departments, { data: people }, { data: lists }, collaborators] = await Promise.all([
    loadActiveDepartments(),
    supabase
      .from("vizserve_pms_users")
      .select("id, full_name, primary_department_id")
      .eq("is_active", true)
      .order("full_name"),
    // P11-06. `NewTaskDialog` always posts to `vizserve_pms_create_task`, which
    // makes a NON-personal task — and a personal list refuses one. Offering the
    // reader's own lists here would be offering the one destination this dialog
    // can never file into. The branch at the top of this function is what handles
    // "I am actually standing in my personal list".
    supabase
      .from("vizserve_pms_lists")
      .select("id, name, department_id")
      .is("owner_id", null)
      .eq("is_active", true)
      .order("name"),
    /*
     * P13-02 — the company roster, for when the department picker is set to a
     * collaboration space.
     *
     * ⚠️ THE `people` READ ABOVE CANNOT SERVE THAT. Its comment says "RLS
     * scopes all three: a TL sees the departments they lead" — which is correct
     * and is exactly the problem: a lead of VizBytes filing into the shared
     * space would be offered VizBytes, under a heading that says everybody.
     */
    loadCollaborators(),
  ]);

  // An admin sees every department; a TL should only be offered the ones they
  // actually lead, or the create call fails after they have filled in the form.
  //
  // ⚠️ P13-01 — PLUS THE COLLABORATION SPACES, FOR EVERYONE. A lead does not
  // lead the shared space and nobody does, so the filter below drops it — which
  // would leave the one department every person may file into missing from the
  // only picker that offers a choice of department. `vizserve_pms_create_task`
  // admits any active user there, so this offers exactly what it accepts.
  const allowed = roleAtLeast(context.role, "owner")
      ? departments
      : departments.filter(
          (department) =>
            context.managedDepartmentIds.includes(department.id) ||
            isCollaborationSpace(context, department.id),
        );

  if (allowed.length === 0) return null;

  const dialog = (
    <NewTaskDialog
      departments={allowed}
      people={people ?? []}
      /* P13-02. Used by the dialog ONLY while the chosen department is a
         collaboration space — see the note on `candidates` there. */
      collaborators={collaborators}
      lists={lists ?? []}
      sharedDepartmentIds={context.sharedDepartmentIds}
      defaultDepartmentId={allowed[0]!.id}
      defaultListId={listId}
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

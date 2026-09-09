"use client";

import { useQuery } from "@tanstack/react-query";

import { roleAtLeast } from "@/lib/auth/roles";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDirectory, fetchVisibleLists } from "@/lib/query/fetchers/task";
import { fetchDepartments } from "@/lib/query/fetchers/task-list";
import { qk } from "@/lib/query/keys";

import { NewPersonalTaskDialog } from "./new-personal-task-dialog";
import { NewTaskDialog } from "./new-task-dialog";
import type { Viewer } from "./tasks-table";

/**
 * P3-12 / P12-07 — the entry point for a task with no request behind it.
 *
 * ------------------------------------------------------------------------
 * ⚠️ IT WAS A SERVER COMPONENT AND IT COULD NOT STAY ONE, and the reason is
 * worth stating because the old header argued the opposite. It said: "a server
 * component so the department, people and list options are fetched once with the
 * page rather than by the dialog on every open". That was the right call while
 * `/tasks` was an RSC. Once the page became a client tree, importing this from
 * it pulled `utils/supabase/server` — and `next/headers` behind it — into the
 * browser bundle, which is a build error by design and the one class of mistake
 * `tsc`, eslint and vitest all pass on.
 *
 * ⚠️ AND THE REASON IT STAYED FETCHED-ONCE IS BETTER THAN IT WAS. Both queries
 * this needs are entries `/tasks` and `/tasks/board` are ALREADY reading —
 * `qk.listsVisible()` and `qk.ref("users")` — so the three server reads it used
 * to issue per page load are now zero: it shares the page's own. That is a
 * deletion of duplicate fetching, not a rewrite. Only `qk.ref("departments")` is
 * its own, it is asked for only on the branch that needs it, and it is reference
 * data with a ten-minute stale time.
 *
 * ⚠️ THE SEAT STILL COMES FROM THE SERVER. `viewer` is built in `page.tsx` from
 * `requireAuthContext()`; nothing here reads a role or a department out of the
 * browser's own idea of who it is. The member branch below used to read
 * `primary_department_id` off the caller's own row with the comment "never sent
 * up as something the browser picked" — that is still true, one step earlier:
 * `viewer.primaryDepartmentId` is that column, read by the auth context on the
 * server. `vizserve_pms_create_task` re-reads it and refuses any other, so this
 * has always been the convenient copy rather than the enforcement.
 * ------------------------------------------------------------------------
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
export function NewTaskButton({
  viewer,
  trigger = "toolbar",
  listId = null,
}: {
  /** The seat, resolved on the server. See `Viewer` in `tasks-table.tsx`. */
  viewer: Viewer;
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
}) {
  const isLead = roleAtLeast(viewer.role, "team_leader");

  const listsQuery = useQuery({
    queryKey: qk.listsVisible(),
    queryFn: () => fetchVisibleLists(browserClient()),
  });

  const peopleQuery = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
  });

  /* Only the lead branch offers a department picker, so only it pays for the
     read. `enabled` rather than a discarded result: a member has no use for the
     list and issuing it would be a round trip nobody reads. */
  const departmentsQuery = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchDepartments(browserClient()),
    enabled: isLead,
  });

  /*
   * ⚠️ NOTHING UNTIL THE OPTIONS ARE THERE, WHICH IS WHAT IT DID BEFORE.
   *
   * As a server component this was awaited in the page's own render, so the
   * button did not exist until its three queries had landed — it was one of the
   * things holding the first flush. Returning null while the shared entries load
   * is the same behaviour with the page no longer waiting on it, and a button
   * that opens a dialog with an empty list picker would be worse than a button
   * that arrives a moment later.
   *
   * An ERROR is not pending. A failed read leaves the button off rather than
   * offering a dialog whose pickers cannot be filled in; the surfaces that own
   * these queries report the failure themselves — see the filter strip in
   * `tasks-view.tsx`.
   */
  if (listsQuery.isPending || peopleQuery.isPending) return null;
  if (!listsQuery.data || !peopleQuery.data) return null;

  const lists = listsQuery.data;
  const people = peopleQuery.data;

  function wrap(dialog: React.ReactNode) {
    // The wrapper belongs to the button, not to the call site. This component
    // returns null for a member with nothing to offer, and a
    // <div className="border-t …"> around a null is a stray rule with padding
    // under it — which is what every board column and every list group grew the
    // first time this was wrapped from outside.
    if (trigger === "column") return <div className="shrink-0 px-2 pb-2">{dialog}</div>;
    if (trigger === "row") return <div className="border-t px-2 py-1.5">{dialog}</div>;
    return dialog;
  }

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
   * The test is `owner_id === me`, not "may I see this list": the question is
   * not visibility but ownership. It used to be a query by primary key with no
   * `is_active` filter, and this reads the shared entry instead, which HAS one —
   * so a personal list that has been archived falls through to the branches
   * below rather than being offered. Reaching one takes a bookmark: the rail
   * lists active lists only.
   */
  const personalList = listId
    ? lists.find((list) => list.id === listId && list.owner_id === viewer.userId)
    : undefined;

  if (personalList) {
    return wrap(
      <NewPersonalTaskDialog
        lists={[{ id: personalList.id, name: personalList.name }]}
        colleagues={[]}
        departmentId={viewer.primaryDepartmentId}
        trigger={trigger}
        defaultListId={personalList.id}
      />,
    );
  }

  /*
   * The member path, and it returns BEFORE the lead branch below.
   *
   * Both of that branch's early returns — the role gate and
   * `allowed.length === 0` — used to swallow this case. Putting the branch
   * after either of them is how "members can create their own tasks" ships as
   * a button that never appears.
   *
   * P7-14 CHANGED WHAT THIS BRANCH NEEDS. It used to fetch only lists, because
   * department and assignee were both resolved server-side and neither was the
   * member's to choose. A member may now assign work to a colleague in their own
   * department, so the dialog needs that department and the people in it.
   */
  if (!isLead) {
    const myDepartment = viewer.primaryDepartmentId;

    return wrap(
      <NewPersonalTaskDialog
        lists={lists.map((list) => ({ id: list.id, name: list.name }))}
        colleagues={
          myDepartment
            ? people.filter(
                (person) =>
                  person.is_active &&
                  person.primary_department_id === myDepartment &&
                  // "Myself" is the dialog's default, not a row in the list,
                  // because the two choices call two different functions and
                  // produce two different `is_personal` values.
                  person.id !== viewer.userId,
              )
            : []
        }
        departmentId={myDepartment}
        trigger={trigger}
        defaultListId={listId}
      />,
    );
  }

  /* The lead branch needs the departments as well, and asks for nothing until
     they are there — same argument as the two above it. */
  if (departmentsQuery.isPending || !departmentsQuery.data) return null;

  // An admin sees every department; a TL should only be offered the ones they
  // actually lead, or the create call fails after they have filled in the form.
  const allowed = roleAtLeast(viewer.role, "owner")
    ? departmentsQuery.data
    : departmentsQuery.data.filter((department) =>
        viewer.managedDepartmentIds.includes(department.id),
      );

  if (allowed.length === 0) return null;

  return wrap(
    <NewTaskDialog
      departments={allowed}
      people={people
        .filter((person) => person.is_active)
        .map((person) => ({
          id: person.id,
          full_name: person.full_name,
          primary_department_id: person.primary_department_id,
        }))}
      /* P11-06. `NewTaskDialog` always posts to `vizserve_pms_create_task`,
         which makes a NON-personal task — and a personal list refuses one.
         Offering the reader's own lists here would be offering the one
         destination this dialog can never file into. The branch at the top of
         this function is what handles "I am actually standing in my personal
         list". */
      lists={lists.filter((list) => list.owner_id === null)}
      defaultDepartmentId={allowed[0]!.id}
      defaultListId={listId}
      trigger={trigger}
    />,
  );
}

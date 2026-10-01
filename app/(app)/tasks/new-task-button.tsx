"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/lib/auth/client-auth";
import { roleAtLeast } from "@/lib/auth/roles";
import { canAccessDepartment, isCollaborationSpace } from "@/lib/auth/rules";
import { browserClient } from "@/lib/query/browser-client";
import {
  fetchActiveDepartments,
  fetchCollaborators,
  fetchDirectory,
  fetchVisibleLists,
} from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";

import { NewPersonalTaskDialog } from "./new-personal-task-dialog";
import { NewTaskDialog } from "./new-task-dialog";

/**
 * "New task", in the three shapes a person can be offered it.
 *
 * P12 Phase A — a client component now. It was an async server component with
 * three reads of its own, which kept `/tasks` rendering on the server per click;
 * it reads the same data from the query cache (all reference entries, usually
 * warm) and decides the same three branches from the layout's auth context:
 *
 *   1. Inside one of your OWN lists → a personal task, filed in that list.
 *   2. A member (below team leader) → your own work; in the collaboration space
 *      the company-task dialog instead.
 *   3. A lead → the full dialog, for the departments you lead plus the
 *      collaboration space (an owner: every department).
 *
 * ⚠️ WHO MAY CREATE WHAT IS STILL THE DATABASE'S CALL. `vizserve_pms_create_task`
 * refuses anything outside these rules; this only decides which dialog to show.
 *
 * Renders nothing until its reads are in — a button that changes shape under
 * the cursor is worse than one that appears a beat late.
 */
export function NewTaskButton({
  trigger = "toolbar",
  listId = null,
}: {
  trigger?: "toolbar" | "column" | "row";
  listId?: string | null;
} = {}) {
  const auth = useAuth();

  const lists = useQuery({ queryKey: qk.listsVisible(), queryFn: () => fetchVisibleLists(browserClient()) });
  const people = useQuery({ queryKey: qk.ref("users"), queryFn: () => fetchDirectory(browserClient()) });
  const departments = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchActiveDepartments(browserClient()),
  });
  const collaborators = useQuery({
    queryKey: qk.ref("collaborators"),
    queryFn: () => fetchCollaborators(browserClient()),
  });

  if (!lists.data || !people.data || !departments.data || !collaborators.data) return null;

  const wrap = (dialog: React.ReactNode) => {
    if (trigger === "column") return <div className="shrink-0 px-2 pb-2">{dialog}</div>;
    if (trigger === "row") return <div className="border-t px-2 py-1.5">{dialog}</div>;
    return dialog;
  };

  const allLists = lists.data.map((list) => ({ id: list.id, name: list.name, department_id: list.department_id }));

  // 1. One of the viewer's own lists: its only possible contents are their own work.
  const personalList = listId
    ? lists.data.find((list) => list.id === listId && list.owner_id === auth.userId)
    : undefined;

  if (personalList) {
    return wrap(
      <NewPersonalTaskDialog
        lists={[{ id: personalList.id, name: personalList.name, department_id: personalList.department_id }]}
        colleagues={[]}
        departmentId={auth.primaryDepartmentId}
        selfId={auth.userId}
        trigger={trigger}
        defaultListId={personalList.id}
      />,
    );
  }

  // 2. A member.
  if (!roleAtLeast(auth.role, "team_leader")) {
    const colleagues = people.data
      .filter(
        (person) =>
          person.is_active &&
          person.id !== auth.userId &&
          auth.primaryDepartmentId !== null &&
          person.primary_department_id === auth.primaryDepartmentId,
      )
      .map((person) => ({ id: person.id, full_name: person.full_name }));

    const listRow = listId ? allLists.find((list) => list.id === listId) : undefined;
    const inShared = listRow
      ? (departments.data.find((department) => department.id === listRow.department_id)?.is_shared ?? false)
      : false;

    return wrap(
      inShared ? (
        /*
         * P13-03 — the company-wide form: `NewCompanyTaskDialog`'s body, with
         * the roster it read on the server taken from the cache instead
         * (`vizserve_pms_collaborators`, which reads past RLS on purpose —
         * see that file). Self excluded: "Myself" is the form's default and
         * calls a different create function.
         */
        <NewPersonalTaskDialog
          lists={allLists}
          colleagues={collaborators.data.filter((person) => person.id !== auth.userId)}
          scope="company"
          departmentId={auth.primaryDepartmentId}
          selfId={auth.userId}
          trigger={trigger}
          defaultListId={listId}
        />
      ) : (
        <NewPersonalTaskDialog
          lists={allLists}
          colleagues={colleagues}
          departmentId={auth.primaryDepartmentId}
          selfId={auth.userId}
          trigger={trigger}
          defaultListId={listId}
        />
      ),
    );
  }

  // 3. A lead.
  const allowed = departments.data
    .filter(
      (department) =>
        canAccessDepartment(auth, department.id) || isCollaborationSpace(auth, department.id),
    )
    .map((department) => ({ id: department.id, name: department.name }));

  if (allowed.length === 0) return null;

  return wrap(
    <NewTaskDialog
      departments={allowed}
      people={people.data
        .filter((person) => person.is_active)
        .map((person) => ({
          id: person.id,
          full_name: person.full_name,
          primary_department_id: person.primary_department_id,
        }))}
      /* P13-02. Used by the dialog ONLY while the chosen department is a
         collaboration space — see the note on `candidates` there. */
      collaborators={collaborators.data}
      lists={lists.data
        .filter((list) => list.owner_id === null)
        .map((list) => ({ id: list.id, name: list.name, department_id: list.department_id }))}
      sharedDepartmentIds={auth.sharedDepartmentIds}
      defaultDepartmentId={allowed[0]!.id}
      defaultListId={listId}
      trigger={trigger}
    />,
  );
}

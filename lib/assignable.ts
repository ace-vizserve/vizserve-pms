import { roleAtLeast, type Role } from "@/lib/auth/roles";

/**
 * P13-02 — WHO A PICKER MAY OFFER, given where the person is standing.
 *
 * ⚠️ NO `server-only` IMPORT, AND THAT IS THE POINT OF THE FILE EXISTING. This
 * rule used to be an inline filter inside `app/(app)/tasks/page.tsx`, which
 * meant it could not be tested and had to be re-derived by eye every time
 * somebody read it. It has now been got wrong twice — once by offering an owner
 * the whole company in every list, once by filtering an already-narrowed set —
 * so it gets a name, a file, and cases.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, IN ONE SENTENCE: THE LIST YOU ARE STANDING IN DECIDES.
 *
 * Amier, 21 Sep: "i can only search all member UNDER THE COMPANY WIDE. IF I AM
 * VIZBYTES AND IT WAS UNDER VIZBYTES I CANT SEARCH ALL, ONLY THE MEMBER OF THAT
 * DEPARTMENT".
 *
 *   in a COLLABORATION list   every active person in the company
 *   in a DEPARTMENT list      that department's people — for EVERYBODY,
 *                             including an owner and including a lead who
 *                             happens to lead two teams
 *   in no list at all         the caller's own scope, which is the rule that
 *                             was always here
 *
 * ⚠️ THE DEPARTMENT-LIST CASE IS NOT MERELY A PREFERENCE. `quickAddTask`
 * derives a task's department from its ASSIGNEE, so offering a VizMedia name
 * while standing in a VizBytes list builds a VizMedia task filed into a
 * VizBytes list — and `vizserve_pms_create_task` refuses that pair with "That
 * list belongs to another department." Offering somebody the server will refuse
 * is a picker producing a guaranteed error message.
 *
 * ⚠️ THE NO-LIST CASE IS NOT DEAD CODE. `?view=mine` and `?view=qa` are the two
 * genuinely cross-list views and carry no `?list=`, so there is no list
 * department to scope to and the caller's own scope is the only answer
 * available.
 *
 * ⚠️ THIS IS THE BUTTON, NEVER THE GATE. `vizserve_pms_create_task` and
 * `vizserve_pms_add_task_assignee` re-decide all of it, and RLS decides what
 * the caller could read in the first place. Getting this wrong shows somebody a
 * name they cannot use; it cannot let them use one.
 */

export type AssignablePerson = {
  id: string;
  full_name: string;
  primary_department_id: string | null;
  is_active: boolean;
};

export function assignableInList({
  people,
  collaborators,
  listDepartmentId,
  sharedDepartmentIds,
  role,
  managedDepartmentIds,
  primaryDepartmentId,
  selfId,
}: {
  /**
   * The RLS-scoped user read the page already has. ⚠️ ALREADY NARROWED: for a
   * member it holds their own department and nothing else, which is why the
   * shared case cannot be served by filtering it.
   */
  people: AssignablePerson[];
  /**
   * `vizserve_pms_collaborators()` — the definer roster. Used ONLY for a
   * collaboration list. Pass `[]` anywhere it is not wanted.
   */
  collaborators: { id: string; full_name: string }[];
  /** The department of the list being viewed, or null for a cross-list view. */
  listDepartmentId: string | null;
  sharedDepartmentIds: readonly string[];
  role: Role;
  managedDepartmentIds: readonly string[];
  primaryDepartmentId: string | null;
  /** Excluded from the result: "Myself" is the composer's default, not a row. */
  selfId: string;
}): { id: string; full_name: string }[] {
  if (listDepartmentId && sharedDepartmentIds.includes(listDepartmentId)) {
    return collaborators.filter((person) => person.id !== selfId);
  }

  const callerScope = new Set(
    [primaryDepartmentId, ...managedDepartmentIds].filter((id): id is string => Boolean(id)),
  );

  return people
    .filter((person) => {
      if (!person.is_active) return false;
      if (person.id === selfId) return false;
      if (person.primary_department_id === null) return false;

      // The list decides, whoever is asking.
      if (listDepartmentId) return person.primary_department_id === listDepartmentId;

      // No list: the caller's own scope, unchanged from before P13-02.
      return roleAtLeast(role, "owner") || callerScope.has(person.primary_department_id);
    })
    .map((person) => ({ id: person.id, full_name: person.full_name }));
}

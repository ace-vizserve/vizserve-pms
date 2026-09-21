import { loadCollaborators } from "@/lib/departments-server";

import { NewPersonalTaskDialog } from "./new-personal-task-dialog";

/**
 * P13-03 — THE COMPANY-WIDE "NEW TASK". THE SECOND FORM.
 *
 * Amier, 21 Sep: "when i said make a separate form like this in the new task
 * thats for the company wide, new task 2. the new task 1 is the current we are
 * using … i only wanted the PIC under the vizbytes retain that the only
 * vizbytes, for example for the global wide you can put everyones PIC all
 * department".
 *
 * So there are two forms now, and which one you get is decided ONCE, on the
 * server, from the list you are filing into (`new-task-button.tsx`):
 *
 *     a list under a DEPARTMENT   → `NewPersonalTaskDialog`, that department
 *     a list under COLLABORATION  → this one, everybody
 *
 * ⚠️ WHY THIS IS A COMPONENT AND NOT A FLAG ON THE OTHER ONE. It was a flag,
 * three times, and it was wrong three times. The dialog was handed two rosters
 * and a boolean and asked to pick; the boolean came from a query that degrades
 * to `[]` on any failure, so every failure picked DEPARTMENT — which on screen
 * is indistinguishable from the feature simply not working. There was no state
 * that said "I could not tell". Splitting the decision out to the server and
 * giving each form exactly one roster removes the choice from the place that
 * kept getting it wrong.
 *
 * ⚠️ A SERVER COMPONENT THAT FETCHES, wrapping the client form. That is the
 * whole substance of it: it is where the company roster is read, and the other
 * form has no way to reach that roster at all. The shared FORM BODY is reused
 * deliberately rather than copied — the fields, the multi-assignee rule and the
 * `is_personal` decision are identical, and a second copy of four hundred lines
 * would drift on the first change to either. What differs is the roster and the
 * sentence under the picker, which is exactly what differs in the requirement.
 *
 * ⚠️ `loadCollaborators` READS PAST RLS ON PURPOSE (P13-02). SELECT on
 * `vizserve_pms_users` is department-scoped, so an ordinary read here would
 * return the caller's own team and this form would be identical to the other
 * one. That is precisely the bug that made "i cant still see all members in
 * here" true. It is safe because this component only ever renders for a list in
 * a shared space, and because `vizserve_pms_create_task` re-checks every name
 * against the same rule before accepting it.
 */
export async function NewCompanyTaskDialog({
  lists,
  defaultListId,
  departmentId,
  selfId,
  trigger = "toolbar",
}: {
  /** Every list the reader can file into — the List field still switches. */
  lists: { id: string; name: string; department_id: string }[];
  defaultListId: string | null;
  /**
   * The reader's OWN department, unchanged and still read on the server.
   *
   * ⚠️ NOT THE COLLABORATION SPACE. `vizserve_pms_create_task` derives the real
   * department from the LIST when that list is shared (P13-01 §5), so the value
   * posted from here is the caller's own and the function overrides it. Passing
   * the shared department instead would be the browser choosing where work is
   * filed, which is the thing that column exists to prevent.
   */
  departmentId: string | null;
  selfId: string;
  trigger?: "toolbar" | "column" | "row" | "quick";
}) {
  const collaborators = await loadCollaborators();

  return (
    <NewPersonalTaskDialog
      lists={lists}
      // ⚠️ SELF EXCLUDED HERE, because the RPC does not do it — it answers "who
      // is assignable", which includes you. This form must not offer you as a
      // row: "Myself" is its default and picking it calls a different create
      // function, so a second way to say the same thing would mean something
      // different.
      colleagues={collaborators.filter((person) => person.id !== selfId)}
      scope="company"
      departmentId={departmentId}
      selfId={selfId}
      trigger={trigger}
      defaultListId={defaultListId}
    />
  );
}

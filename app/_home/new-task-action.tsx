import { loadPersonalTaskOptions } from "@/lib/personal-task-server";
import { requireAuthContext } from "@/lib/auth/authorization";

import { NewPersonalTaskDialog } from "@/app/(app)/tasks/new-personal-task-dialog";

/**
 * The home page's "New task" quick action.
 *
 * ⚠️ IT USED TO BE A LINK TO `/tasks`, which is not a page. `/tasks` redirects
 * to `/tasks/lists` when it carries no `?list=`, so the one action on this page
 * that says "new" landed the reader on a directory of folders with nothing
 * created and no form open — the same failure the four `?type=` actions beside
 * it had before slice F gave them a real prefill contract.
 *
 * ⚠️ THE PERSONAL DIALOG FOR EVERYONE, and that is a choice rather than the
 * role branch `new-task-button.tsx` makes. This page is a personal glance — am I
 * timed in, what is waiting on me, who is out — so the task it creates is
 * mine or a colleague's in my own department. Somebody filing work into a
 * department they merely lead is doing a different job, and that job has a
 * fuller dialog on `/tasks` with a department picker and a QA seat.
 *
 * The narrower dialog is also the safe default: it has no department field at
 * all. `vizserve_pms_create_task` resolves the caller's department from their
 * own row and refuses any other, so nothing here can file work somewhere the
 * server would not have accepted anyway.
 */
export async function HomeNewTaskAction() {
  const context = await requireAuthContext();
  // ⚠️ THIS WAS A VERBATIM COPY of the member branch in
  // `app/(app)/tasks/new-task-button.tsx`, comments included. One definition
  // now, in `lib/personal-task-server.ts`.
  const {
    departmentId: myDepartment,
    lists,
    colleagues,
    everyone,
  } = await loadPersonalTaskOptions(context.userId);

  return (
    <NewPersonalTaskDialog
      lists={lists}
      colleagues={colleagues}
      /* P13-01. The collaboration space reaches this dialog too: it is in
         `lists`, so somebody can file company-wide work from the home page
         without going to /tasks first. */
      everyone={everyone}
      sharedDepartmentIds={context.sharedDepartmentIds}
      departmentId={myDepartment}
      selfId={context.userId}
      trigger="quick"
    />
  );
}

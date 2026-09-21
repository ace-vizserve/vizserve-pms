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
  const { departmentId: myDepartment, lists, colleagues } = await loadPersonalTaskOptions(
    context.userId,
  );

  /*
   * ⚠️ THE DEPARTMENT FORM, ALWAYS — P13-03, and it is a deliberate narrowing.
   *
   * This page has no list in hand: it is a personal glance, not a list view, so
   * there is nothing to decide "which of the two forms" from. Defaulting to the
   * DEPARTMENT one is the safe half of that choice — it offers only people the
   * server will certainly accept for an unlisted task, which is filed under the
   * caller's own department by `vizserve_pms_create_personal_task`.
   *
   * Company-wide work is filed from the Company-wide list itself, where
   * `new-task-button.tsx` can see which list it is. If this page ever grows a
   * list picker, it grows the same choice with it.
   */
  return (
    <NewPersonalTaskDialog
      lists={lists}
      colleagues={colleagues}
      departmentId={myDepartment}
      selfId={context.userId}
      trigger="quick"
    />
  );
}

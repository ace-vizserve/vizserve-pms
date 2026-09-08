import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";

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
  const supabase = await createClient();

  const { data: me } = await supabase
    .from("vizserve_pms_users")
    .select("primary_department_id")
    .eq("id", context.userId)
    .maybeSingle();

  const myDepartment = me?.primary_department_id ?? null;

  const [{ data: lists }, { data: colleagues }] = await Promise.all([
    // RLS scopes this to the reader's own department — no filter needed here,
    // and adding one would imply the policy were optional.
    supabase.from("vizserve_pms_lists").select("id, name").eq("is_active", true).order("name"),
    // `.neq` on themselves: "Myself" is the dialog's default rather than a row
    // in the picker, because the two choices call two different functions and
    // produce two different `is_personal` values.
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

  return (
    <NewPersonalTaskDialog
      lists={lists ?? []}
      colleagues={colleagues ?? []}
      departmentId={myDepartment}
      trigger="quick"
    />
  );
}

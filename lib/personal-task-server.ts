import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

/**
 * What the "new personal task" dialog needs to open.
 *
 * TWO CALLERS AND THEY WERE A COPY-PASTE, comments and all: the member branch of
 * `app/(app)/tasks/new-task-button.tsx` and `app/_home/new-task-action.tsx`.
 * Three queries each, byte for byte, in two route groups — so "who may I assign
 * to" had two homes and any change to it had to find both.
 *
 * ⚠️ THE DEPARTMENT IS READ HERE, ON THE SERVER, from the caller's own row, and
 * never sent up as something the browser picked. `vizserve_pms_create_task`
 * re-reads it and refuses any other, so this is the convenient copy rather than
 * the enforcement.
 *
 * ⚠️ `.neq` ON THEMSELVES IS NOT A TIDY-UP. "Myself" is the dialog's DEFAULT
 * rather than a row in the picker, because the two choices call two different
 * functions and produce two different `is_personal` values. Putting the reader
 * back in the list gives them two ways to say the same thing that mean
 * different things.
 *
 * NO SCOPE FILTER ON THE LISTS. RLS scopes them to the reader's own department;
 * adding one here would imply the policy were optional.
 */

export type PersonalTaskOptions = {
  /**
   * The reader's own department, read from their row. The dialog posts it back
   * and `vizserve_pms_create_task` re-reads it and refuses any other, so this
   * is the convenient copy rather than the enforcement.
   */
  departmentId: string | null;
  lists: { id: string; name: string }[];
  colleagues: { id: string; full_name: string }[];
};

export const loadPersonalTaskOptions = cache(
  async (userId: string): Promise<PersonalTaskOptions> => {
    const supabase = await createClient();

    const { data: me } = await supabase
      .from("vizserve_pms_users")
      .select("primary_department_id")
      .eq("id", userId)
      .maybeSingle();

    const myDepartment = me?.primary_department_id ?? null;

    const [{ data: lists }, { data: colleagues }] = await Promise.all([
      supabase.from("vizserve_pms_lists").select("id, name").eq("is_active", true).order("name"),

      // Nobody to offer when the reader has no department: the filter would be
      // `primary_department_id = null`, which matches nothing and costs a round
      // trip to find that out.
      myDepartment
        ? supabase
            .from("vizserve_pms_users")
            .select("id, full_name")
            .eq("primary_department_id", myDepartment)
            .eq("is_active", true)
            .neq("id", userId)
            .order("full_name")
        : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    ]);

    return { departmentId: myDepartment, lists: lists ?? [], colleagues: colleagues ?? [] };
  },
);

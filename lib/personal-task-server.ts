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
 * ⚠️ P13-03 — IT RETURNS THE DEPARTMENT ROSTER AND NOTHING ELSE. It briefly
 * returned two — `colleagues` and `everyone` — and the DIALOG picked between
 * them using a third input, `sharedDepartmentIds`. Three things to arrive
 * correctly and be combined correctly; any one of them empty or stale silently
 * produced the department answer, which on screen is indistinguishable from the
 * collaboration space not working. It was got wrong three times in one
 * afternoon.
 *
 * P13-03 answers it by SPLITTING THE FORM IN TWO instead, which is what Amier
 * asked for: `NewPersonalTaskDialog` is the department form and gets
 * `colleagues` from here; `NewCompanyTaskDialog` is the company-wide form and
 * gets its own roster from `loadCollaborators()`. Neither of them chooses. The
 * choice is made once, on the server, from the list being filed into — see
 * `new-task-button.tsx`.
 *
 * ⚠️ THE DEPARTMENT IS STILL READ HERE, ON THE SERVER, from the caller's own
 * row, and never sent up as something the browser picked. `vizserve_pms_create_task`
 * re-reads it and refuses any other, so this is the convenient copy rather than
 * the enforcement.
 *
 * NO SCOPE FILTER ON THE LISTS. RLS scopes them — which, since P13-01, includes
 * the collaboration space's lists for everybody. Adding one here would imply the
 * policy were optional.
 */

export type PersonalTaskOptions = {
  /**
   * The reader's own department, read from their row. The dialog posts it back
   * and `vizserve_pms_create_task` re-reads it and refuses any other, so this
   * is the convenient copy rather than the enforcement.
   */
  departmentId: string | null;
  /**
   * P13-01. `department_id` rides along so the dialog can tell the picker WHICH
   * list a task is going into — which is now the only input the roster depends
   * on.
   */
  lists: { id: string; name: string; department_id: string }[];
  /**
   * Active people in the reader's OWN department, themselves excluded.
   *
   * ⚠️ THIS IS THE DEPARTMENT FORM'S ROSTER AND ONLY ITS ROSTER. The
   * company-wide form does not come through here at all — it has its own
   * component and its own roster (`loadCollaborators`). Keeping the two apart
   * is the point: a single dialog choosing between two rosters from a flag is
   * what was wrong three times over.
   */
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
      supabase
        .from("vizserve_pms_lists")
        // P13-01. `department_id` — see the note on the type.
        .select("id, name, department_id")
        .eq("is_active", true)
        .order("name"),

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

    return {
      departmentId: myDepartment,
      lists: lists ?? [],
      colleagues: colleagues ?? [],
    };
  },
);

import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
import { loadCollaborators } from "@/lib/departments-server";

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
  /**
   * P13-01. `department_id` rides along so the dialog can tell a collaboration
   * list from an ordinary one — which is what decides whether the whole company
   * is assignable or only the reader's own team.
   */
  lists: { id: string; name: string; department_id: string }[];
  colleagues: { id: string; full_name: string }[];
  /**
   * P13-01 — EVERY ACTIVE PERSON, themselves excluded. Offered ONLY while a
   * collaboration list is selected.
   *
   * ⚠️ NOT A WIDER `colleagues`, AND THE TWO MUST NOT BE MERGED. In an ordinary
   * department list, `vizserve_pms_create_task` still refuses an assignee from
   * another team — the rule exists so nobody holds work their own lead cannot
   * see. Offering this set there would be offering a guaranteed error message.
   * In a shared space every lead can see it, which is exactly why the function
   * relaxes the test there and only there.
   */
  everyone: { id: string; full_name: string }[];
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

    // ⚠️ `everyone` IS NOT DESTRUCTURED. The two above are PostgREST results
    // and carry `{ data }`; `loadCollaborators` is an RPC wrapper that has
    // already unwrapped and degraded its own, so it hands back the array.
    const [{ data: lists }, { data: colleagues }, everyone] = await Promise.all([
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

      /*
       * P13-01 — the whole company, for a collaboration list.
       *
       * ⚠️ P13-02 — THIS WAS A `from("vizserve_pms_users")` READ AND IT RETURNED
       * THE READER'S OWN DEPARTMENT. Amier, standing in Company-wide with the
       * picker open: "i cant still see all members in here". SELECT on that
       * table is department-scoped by five additive policies, so a plain read
       * through the caller's own client answers "everyone I could already see"
       * — six names — however true the database rule underneath is.
       *
       * `loadCollaborators` is the definer RPC that reads past it. See the note
       * there for why it is a function and not a wider policy.
       *
       * ⚠️ A SEPARATE CALL RATHER THAN A WIDER `colleagues`. The narrow list is
       * an indexed `.eq("primary_department_id", …)` the database applies, and
       * it is what every ORDINARY list still uses — deriving it by filtering
       * this one in TypeScript would move the correctness of the common case out
       * of the query and into this file. The two go out in the same wave.
       */
      loadCollaborators(),
    ]);

    return {
      departmentId: myDepartment,
      lists: lists ?? [],
      colleagues: colleagues ?? [],
      /*
       * ⚠️ SELF EXCLUDED HERE, BECAUSE THE RPC DOES NOT DO IT. The narrow query
       * above carries `.neq("id", userId)` and `vizserve_pms_collaborators()`
       * deliberately does not — it answers "who is assignable", which includes
       * you, and it has other callers that want you in the list.
       *
       * This dialog is the one that must not have you in it: "Myself" is its
       * DEFAULT rather than a row, because picking yourself calls a different
       * function and produces a different KIND of task. A second way to say the
       * same thing that means something else is the bug the `.neq` prevents.
       */
      everyone: everyone.filter((person) => person.id !== userId),
    };
  },
);

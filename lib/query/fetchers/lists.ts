import { parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  managedGroupSchema,
  managedListSchema,
  openTaskListIdSchema,
  type ManagedGroup,
  type ManagedList,
} from "@/lib/schemas/lists";

import type { TaskReadClient } from "./task";

/**
 * P12-16 — the reads behind `/tasks/lists`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `page.tsx` was an RSC that awaited four queries — the
 * lists, the departments, the folders and a scan of every open task — and then
 * handed the whole tree to `list-manager.tsx` as props. Every save went through
 * `revalidatePath("/tasks/lists")` plus a `router.refresh()`, which re-ran all
 * four to move one row's name. The `useOptimistic` in that component existed
 * only to bridge the gap while they ran.
 *
 * ⚠️ THE FOUR BECAME ONE KEY, NOT FOUR. `qk.listsManaged()` holds the folders,
 * the lists and the counts together, and the argument for that is in `keys.ts`:
 * a rename, an archive and a move each touch more than one of the three, so
 * three keys would be three refetches with nothing to tell them apart. The
 * DEPARTMENTS did not come along — see `fetchDepartments` in `task-list.ts`,
 * which already files them as `qk.ref("departments")`, where every picker in the
 * app can share the one entry.
 *
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER, and nothing here may start to. All
 * three reads are RLS-scoped: a lead sees the departments they lead and those
 * departments' folders, lists and tasks. There is no `.in("department_id", …)`
 * anywhere below and adding one would imply the policy were optional (CLAUDE.md).
 *
 * ⚠️ THE TWO FILTERS THAT ARE HERE ARE ABOUT WHICH ROWS, NOT ABOUT WHO. The
 * `owner_id is null` on the lists is P11-06 and is explained at its line; the
 * status exclusion on the tasks is what makes the count an OPEN count.
 *
 * ⚠️ AND EVERY ONE GOES THROUGH `read()`, WHICH THROWS. There is no `?? []` in
 * this file and there must never be one — the page previously wrote `lists ?? []`
 * four times over, which rendered a failed read as "Nothing organised yet" on a
 * screen whose empty state invites you to create the first list. Somebody acting
 * on that would have made a duplicate of a list they already had.
 * ------------------------------------------------------------------------
 */

/**
 * `qk.listsManaged()` — the whole tree this screen draws.
 *
 * Three reads in ONE wave. None of them takes an argument from another: the
 * lists, the folders and the task scan are all keyed by nothing but the reader's
 * own scope. The RSC already batched them for the same reason and the note it
 * carried is kept — the counts used to be awaited on their own line after the
 * department scoping, which depended on nothing they produce.
 */
export type ManagedLists = {
  lists: ManagedList[];
  groups: ManagedGroup[];
  /** List id → how many open tasks are sitting in it. */
  openCounts: Record<string, number>;
};

export async function fetchManagedLists(client: TaskReadClient): Promise<ManagedLists> {
  const [listRows, groupRows, taskRows] = await Promise.all([
    read<unknown[]>(
      client
        .from("vizserve_pms_lists")
        .select("id, name, description, department_id, is_active, sort_order, group_id, form_id")
        /*
         * P11-06. This screen is how a DEPARTMENT is organised — folders, sort
         * order, which team a list belongs to. None of it applies to a personal
         * list, which is in no folder and belongs to a person; those are made
         * and renamed from the sidebar's Personal lists group instead.
         *
         * ⚠️ NOT REDUNDANT WITH RLS. The policy lets the caller read their OWN
         * personal lists, so without this a lead would find their private lists
         * sitting in their department's tree here, offered a folder picker the
         * check constraint refuses.
         */
        .is("owner_id", null)
        .order("sort_order")
        .order("name"),
    ),

    /*
     * P7-18. NO `is_active` FILTER, deliberately — same as the lists query
     * above. This is the screen where an archived folder is un-archived, so
     * filtering it out here would make that impossible from the only place it
     * is offered.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_task_groups")
        .select("id, name, description, department_id, is_active, sort_order, is_system")
        .order("sort_order")
        .order("name"),
    ),

    /*
     * How many tasks each list holds, so nobody archives a list that is
     * carrying live work without knowing.
     *
     * ⚠️ ONE COLUMN FOR EVERY OPEN TASK IN SCOPE, TALLIED IN THE BROWSER, and
     * it is the same query the RSC ran. PostgREST has no per-group count, so the
     * alternatives are this or one `head: true` count per list — an N+1 over a
     * tree that can hold dozens. A uuid per open task is small, and it is now
     * fetched ONCE per tab rather than on every save: this was the most
     * expensive of the four reads and `revalidatePath` re-ran it to rename a
     * list. It is the one query on this screen worth watching if a department
     * ever carries thousands of open tasks at once.
     */
    read<unknown[]>(
      client
        .from("vizserve_pms_tasks")
        .select("list_id")
        .not("list_id", "is", null)
        .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)"),
    ),
  ]);

  const openCounts: Record<string, number> = {};
  for (const row of parseAll(openTaskListIdSchema, taskRows, "open task counts")) {
    if (!row.list_id) continue;
    openCounts[row.list_id] = (openCounts[row.list_id] ?? 0) + 1;
  }

  return {
    lists: parseAll(managedListSchema, listRows, "lists"),
    groups: parseAll(managedGroupSchema, groupRows, "folders"),
    openCounts,
  };
}

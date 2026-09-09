import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  canAdminDepartment,
  realtimeDepartmentFilter,
  requireAuthContext,
} from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import { fetchJoinedTaskIdSet } from "@/lib/tasks-server";
import { createClient } from "@/utils/supabase/server";

import { TaskDetail, type TaskSeat } from "./task-detail";

export const metadata: Metadata = { title: "Task" };

/**
 * P3-05 / P12-06 — task detail: the SERVER half, which is auth and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — 999 lines, a task row and then a
 * twelve-query `Promise.all`, all in one RSC. Phase 3a moved the reads into the
 * TanStack cache (`task-detail.tsx`, `lib/query/fetchers/task.ts`) and left
 * behind exactly the three things that must not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase. It also runs in `app/(app)/layout.tsx` above this;
 *      calling it here is what gives this file the CONTEXT, not what enforces
 *      the gate.
 *   2. THE `notFound()` SCOPE CHECK. Out of scope returns NO ROW under RLS, so
 *      this 404s rather than confirming the task exists to somebody who cannot
 *      see it — and it has to happen HERE, on the server, because
 *      `app/(app)/not-found.tsx` is reached with `notFound()` and a client
 *      component cannot call it during a render. Doing it in the browser would
 *      also mean the shell paints a task page first and then admits there is no
 *      task, which is the leak the 404 exists to avoid saying out loud.
 *   3. THE SEAT. `viewer` is built from `role`, `managedDepartmentIds`,
 *      `canAdminDepartment` and the P7-13/P7-43 join table — role and department
 *      decisions, every one of them. They are computed here and travel down as
 *      flags; see `TaskSeat` for the two column comparisons the client is left
 *      to make and why.
 *
 * ⚠️ AND THE SCOPE CHECK COSTS ONE SMALL READ, ON PURPOSE. It selects six
 * columns rather than the twenty-one the page needs, because the page's own copy
 * of the row now comes from `qk.task(id)` in the browser. Widening this back out
 * to "everything, so the client does not have to fetch it" would put the row on
 * the server render again and undo the phase — the browser would still refetch
 * it, and the two copies would disagree for one frame after every write.
 * ------------------------------------------------------------------------
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireAuthContext();
  const supabase = await createClient();

  /*
   * ⚠️ ONE WAVE, NOT TWO. The join-table read needs only the signed-in user, so
   * it does not wait on the task row — the same argument the twelve-query batch
   * made before it was moved, kept for the two reads that are left.
   */
  const [{ data: task }, joinedTaskIdSet] = await Promise.all([
    // Out of scope returns no row under RLS, so this 404s rather than confirming
    // the task exists to someone who cannot see it.
    supabase
      .from("vizserve_pms_tasks")
      .select("id, department_id, assignee_id, qa_assignee_id, request_id, is_personal")
      .eq("id", id)
      .maybeSingle(),

    /*
     * P7-13 / P7-43 — the tasks this person is on without being named in
     * `assignee_id`.
     *
     * ⚠️ IT STAYS ON THE SERVER AND IT IS THE ONE READ THAT NEVER BECAME A QUERY
     * KEY. It answers a SEAT question, which belongs with the auth context — and
     * it is also the read the plan flags as not splitting cleanly, because every
     * other caller does `.in("task_id", taskIds)` across a whole list. Here there
     * is one task, so it collapses to a boolean before it crosses the seam.
     *
     * `cache()`d per request in `lib/tasks-server.ts`, and it degrades to an
     * empty set on failure by that file's own stated rule: it WIDENS the set of
     * tasks somebody can already reach through `assignee_id`, so a failure shows
     * them less than they should see rather than taking the page out.
     */
    fetchJoinedTaskIdSet(context.userId),
  ]);

  if (!task) notFound();

  /*
   * ⚠️ EVERY ROLE AND DEPARTMENT DECISION, MADE HERE. Nothing below this line is
   * re-derived in the browser — see `TaskSeat`. And none of it protects
   * anything on its own: `lib/schemas/tasks.ts` says in capitals that `viewer`
   * is PRESENTATION ONLY, and the same rules are re-checked in
   * `vizserve_pms_transition_task` and in both tasks policies. This exists so
   * the controls on screen match what the server will accept.
   */
  const seat: TaskSeat = {
    userId: context.userId,
    joined: joinedTaskIdSet.has(task.id),
    leadsDepartment:
      roleAtLeast(context.role, "owner") ||
      context.managedDepartmentIds.includes(task.department_id),
    isAdmin: roleAtLeast(context.role, "owner"),
    // P11-05 — `primary_department_id` is what this schema means by "a member of
    // a department" everywhere else. Mirrors `v_in_dept`.
    inDepartment: context.primaryDepartmentId === task.department_id,
    // P8-01c — the Admin tick on THIS task's department. Beside
    // `leadsDepartment` rather than inside it: the tick confers only the
    // force-status link, not renaming, editing, uploading or reassigning.
    administersDepartment: canAdminDepartment(context, task.department_id),
  };

  return (
    <TaskDetail
      taskId={task.id}
      seat={seat}
      /* P8-03 — department-wide, not `id=eq.<this task>`. The reasoning is at
         the `<RealtimeTasks>` call site; it is computed here because it reads
         the auth context, which does not cross into the browser. */
      realtimeFilter={realtimeDepartmentFilter(context)}
    />
  );
}

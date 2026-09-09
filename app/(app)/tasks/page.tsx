import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  canAdminDepartment,
  realtimeDepartmentFilter,
  requireAuthContext,
} from "@/lib/auth/authorization";

import { TasksView, type TasksSearchParams } from "./tasks-view";
import type { Viewer } from "./tasks-table";

export const metadata: Metadata = { title: "Tasks" };

/**
 * P3-03 / P3-14 / P12-07 — the task list: the SERVER half, which is auth and
 * the bare-route redirect and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — 1,156 lines, a row query and then a
 * six-query batch against the ids it returned, plus every derivation the table
 * reads. P12-07 moved the reads into the TanStack cache (`tasks-view.tsx`,
 * `lib/query/fetchers/task-list.ts`) and left behind exactly the two things that
 * must not move, and the one that follows from them:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase. It also runs in `app/(app)/layout.tsx` above this;
 *      calling it here is what gives this file the CONTEXT, not what enforces
 *      the gate.
 *   2. THE REDIRECT. `redirect()` is a server call and belongs on this side; a
 *      client component cannot make it during a render, and sending somebody to
 *      the list tree after painting an empty task page would be worse than not
 *      sending them at all.
 *   3. THE VIEWER. Every field on it is a role or department decision, and
 *      `canAdminDepartment` lives in a `server-only` module — so the Admin tick
 *      has to be resolved here and travel as a flag. See `Viewer` in
 *      `tasks-table.tsx` for what each field is and is not.
 *
 * ⚠️ AND IT ISSUES NO QUERY AT ALL NOW, WHICH IS THE POINT. Every navigation
 * into a list used to cost fourteen server reads before the browser saw a row;
 * it costs the session lookup `requireAuthContext()` already does for the layout
 * and nothing else, and the rows come from the cache if they are there.
 * ------------------------------------------------------------------------
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<TasksSearchParams>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

  /*
   * ⚠️ THE BARE ROUTE NO LONGER RENDERS ANYTHING. It sends you to the list tree.
   *
   * `/tasks` with no list listed EVERY task the reader could see — for a lead,
   * a whole department, thousands of rows spread across every list — under a
   * heading that promised precisely that and helped with nothing. Work here is
   * organised by list, and the flat dump was a different product wearing the
   * same route.
   *
   * Amier, 7 Sep: "the all tasks page should not be existing as its confusing,
   * task viewing should be by list only". The "All tasks" entry in the sidebar
   * went with it — see `components/app-shell/nav-projects.tsx`.
   *
   * ⚠️ THE TWO CROSS-LIST VIEWS SURVIVE, AND DELETING THEM WOULD BREAK FIVE
   * LINKS. "What is on me" and "what am I reviewing" are questions no single
   * list can answer, and `/dashboard` and `/` both link to them — the stat
   * tiles, the Needs-you overflow, the QA tile. So `?view=mine` and `?view=qa`
   * still render, and only the unfiltered entry point is gone.
   *
   * A REDIRECT RATHER THAN A DELETED FILE, deliberately: every `?list=` link in
   * the tree, every `router.refresh()` after a mutation and every bookmark
   * still resolves here. Removing the route would break all of them.
   */
  if (!params.list && params.view !== "mine" && params.view !== "qa") {
    redirect("/tasks/lists");
  }

  const viewer: Viewer = {
    userId: context.userId,
    role: context.role,
    managedDepartmentIds: context.managedDepartmentIds,
    /*
     * P8-01c — the Admin tick, resolved HERE rather than shipped as the raw
     * `is_dept_admin` column.
     *
     * `canAdminDepartment` is the single TypeScript reading of
     * `vizserve_pms_is_dept_admin`, and it lives in a `server-only` module, so
     * the boolean has to be answered on this side of the wire. Sending the flag
     * instead would put a second reading of the capability in a client
     * component — which is the "scattered `if (role === 'admin')`" CLAUDE.md
     * exists to forbid, one capability later.
     */
    deptAdminOf: canAdminDepartment(context, context.primaryDepartmentId)
      ? context.primaryDepartmentId
      : null,
    /* P11-05 — the department this person BELONGS to, compared against each
       task's own on the client. Raw, unlike `deptAdminOf` above: this one
       carries no capability by itself, it is one half of a comparison. */
    primaryDepartmentId: context.primaryDepartmentId,
  };

  return (
    <TasksView
      params={params}
      viewer={viewer}
      /* P8-03 — department-wide, not one list. The reasoning is at the
         `<RealtimeTasks>` call site; it is computed here because it reads the
         auth context, which does not cross into the browser. */
      realtimeFilter={realtimeDepartmentFilter(context)}
    />
  );
}

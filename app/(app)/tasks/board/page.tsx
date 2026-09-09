import type { Metadata } from "next";

import {
  canAdminDepartment,
  realtimeDepartmentFilter,
  requireAuthContext,
} from "@/lib/auth/authorization";

import type { Viewer } from "../tasks-table";
import { BoardView, type BoardSearchParams } from "./board-view";

export const metadata: Metadata = { title: "Board" };

/**
 * P3-04 / P12-07 — the board: the SERVER half, which is auth and the seat.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — 1,051 lines, two card queries, a
 * dependent subtask query and every derivation the columns read. P12-07 moved
 * the reads into the TanStack cache (`board-view.tsx`,
 * `lib/query/fetchers/task-list.ts`) and left behind the two things that must
 * not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase. It also runs in `app/(app)/layout.tsx` above this;
 *      calling it here is what gives this file the CONTEXT, not what enforces
 *      the gate.
 *   2. THE VIEWER. Every field on it is a role or department decision, and
 *      `canAdminDepartment` lives in a `server-only` module — so the P8-01c
 *      Admin tick has to be resolved here and travel as a flag. It is the same
 *      object `/tasks` builds and `tasks-table.tsx` documents field by field,
 *      which is the point: two surfaces asking the same question of the same
 *      shape cannot answer it differently.
 *
 * ⚠️ ONE READ LEFT THIS FILE RATHER THAN MOVING WITH THE REST:
 * `fetchJoinedTaskIdSet`. The board used it for `seat()` — "is this person on
 * this card without being named in `assignee_id`" — and it answers that with
 * EVERY task they are on anywhere. That module is `server-only`, and passing its
 * result down as a prop would have frozen it the moment P12-09 stopped
 * re-rendering this route on a write. The board asks the same question the list
 * has always asked instead: the join rows for the cards on screen, in the same
 * key as the cards. See `TaskBoardView.assignees`.
 * ------------------------------------------------------------------------
 */
export default async function TaskBoardPage({
  searchParams,
}: {
  searchParams: Promise<BoardSearchParams>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

  const viewer: Viewer = {
    userId: context.userId,
    role: context.role,
    managedDepartmentIds: context.managedDepartmentIds,
    /*
     * P8-01c — the Admin tick, resolved HERE rather than shipped as the raw
     * `is_dept_admin` column. `canAdminDepartment` is the single TypeScript
     * reading of `vizserve_pms_is_dept_admin` and it is `server-only`, so the
     * boolean has to be answered on this side of the wire. Sending the flag
     * instead would put a second reading of the capability in a client
     * component — the "scattered `if (role === 'admin')`" CLAUDE.md forbids.
     */
    deptAdminOf: canAdminDepartment(context, context.primaryDepartmentId)
      ? context.primaryDepartmentId
      : null,
    /* P11-05 — the department this person BELONGS to, compared against each
       task's own on the client. Raw, unlike `deptAdminOf`: it carries no
       capability by itself, it is one half of a comparison. */
    primaryDepartmentId: context.primaryDepartmentId,
  };

  return (
    <BoardView
      params={params}
      viewer={viewer}
      /* P8-03 — department-wide, not one list. The reasoning is at the
         `<RealtimeTasks>` call site; it is computed here because it reads the
         auth context, which does not cross into the browser. */
      realtimeFilter={realtimeDepartmentFilter(context)}
    />
  );
}

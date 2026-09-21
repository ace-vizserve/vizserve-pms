import type { Metadata } from "next";
import { Suspense } from "react";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { realtimeDepartmentFilter, requireAuthContext } from "@/lib/auth/authorization";
import { applyTaskScope } from "@/lib/tasks-server";
import { createClient } from "@/utils/supabase/server";

import { TaskToolbar } from "../toolbar";
import { TaskGanttView, type GanttTask } from "./gantt-view";

export const metadata: Metadata = { title: "Gantt" };

type GanttSearchParams = {
  view?: string;
  kind?: string;
  list?: string;
};

type Scope = "all" | "mine" | "qa";
type Kind = "all" | "internal" | "client";

/** Same one-row-by-primary-key crumb the board uses, on its own boundary. */
async function GanttCrumb({ listId }: { listId: string }) {
  const supabase = await createClient();
  const { data: openList } = await supabase
    .from("vizserve_pms_lists")
    .select("name")
    .eq("id", listId)
    .maybeSingle();

  return openList ? <BreadcrumbLabel value={openList.name} /> : null;
}

/**
 * The timeline — a THIRD READ of the same tasks, after the list and the board.
 *
 * ClickUp offers a Gantt as a view you switch a list into rather than a kind of
 * list you create, and that is the shape copied here (D21: the feature's shape
 * carries over, nothing else does). So there is no column on
 * `vizserve_pms_lists` recording a default view and no migration behind this
 * page — the view lives in the pathname, exactly as Board does, and every list
 * has all three available to it.
 *
 * ⚠️ NO `status` NARROWING, unlike the board.
 *
 * The board drops the two terminal stages from its main query because a column
 * that accumulates every finished ticket stops being a board. A timeline has
 * the opposite problem: work that finished last week is the context that makes
 * this week legible, and a Gantt with the completed bars cut out is a schedule
 * with holes in it. The natural bound here is the axis, not the status.
 */
export default async function TaskGanttPage({
  searchParams,
}: {
  searchParams: Promise<GanttSearchParams>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

  /* The same three parameters the board reads, for the same reason: the toolbar
     carries them across the switch, so a view that ignored one would claim a
     filter it does not apply. */
  const listId = params.list ?? null;
  const kind: Kind = params.kind === "internal" || params.kind === "client" ? params.kind : "all";
  const scope: Scope = params.view === "mine" || params.view === "qa" ? params.view : "all";

  const supabase = await createClient();

  /*
   * Ordered by `start_date`, which is the axis this page is drawn on — the
   * board and list order by `due_date` because that is the question they
   * answer. `nullsFirst: false` keeps the rows that cannot be drawn at the end,
   * where the view counts them rather than plotting them.
   *
   * No department filter: the policy does it (CLAUDE.md). `applyTaskScope` adds
   * only what the URL asked for.
   */
  const query = applyTaskScope(
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, start_date, due_date")
      .order("start_date", { ascending: true, nullsFirst: false }),
    { listId, view: scope, kind, userId: context.userId },
  );

  const { data } = await query;
  const tasks = (data ?? []) as GanttTask[];

  return (
    <PageShell className="h-[calc(100svh-3.5rem)] min-h-0 gap-3 overflow-hidden">
      {/* P8-03 — same contract as the board: the ping triggers a refresh and the
          page is re-queried under RLS, so a bar can never appear here that the
          policy would have refused. */}
      <RealtimeTasks filter={realtimeDepartmentFilter(context)} />

      {listId ? (
        <Suspense fallback={null}>
          <GanttCrumb listId={listId} />
        </Suspense>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TaskToolbar view="gantt" />
      </div>

      <TaskGanttView listId={listId} tasks={tasks} />
    </PageShell>
  );
}

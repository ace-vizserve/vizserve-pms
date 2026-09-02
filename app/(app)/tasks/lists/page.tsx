import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { departmentShapeScope, requireDepartmentShape } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";

import { ListManager } from "./list-manager";

export const metadata: Metadata = { title: "Lists" };

/**
 * P3-01 — managing lists.
 *
 * The table and the save action shipped with Phase 3; this screen did not, and
 * `revalidatePath("/tasks/lists")` was pointing at a route that returned 404 —
 * the same shape of gap `/admin/users` had. Without it a list can only be
 * created by hand in SQL, which makes the list filter on the task board and the
 * form's default list both permanently empty.
 *
 * Team-leader and above: a list is how a department organises its own work
 * (Amier ~33:00), so the people who lead it own the shape of it.
 *
 * ⚠️ P8-01c — AND SO DOES A DEPARTMENT ADMIN, AT ANY RANK. The gate moved from
 * `requireRole("team_leader")` to `requireDepartmentShape()`, which admits both
 * routes. A member holding the Admin tick has to genuinely reach this screen or
 * the tick grants nothing: `p8_01c` widened the folder and list write policies
 * to `vizserve_pms_is_dept_admin`, and a migration whose screen still refuses
 * the caller is the failure docs/13-implementation-status.md records four times
 * in two days.
 */
export default async function ListsPage() {
  const context = await requireDepartmentShape();
  const supabase = await createClient();

  // Both are RLS-scoped: a TL sees the departments they lead and those
  // departments' lists. No `.in()` needed, and restating it here would imply
  // the policy were optional.
  const [{ data: lists }, { data: departments }, { data: groups }] = await Promise.all([
    supabase
      .from("vizserve_pms_lists")
      .select("id, name, description, department_id, is_active, sort_order, group_id, form_id")
      .order("sort_order")
      .order("name"),
    supabase.from("vizserve_pms_departments").select("id, name").eq("is_active", true).order("name"),
    // P7-18. NO `is_active` FILTER, deliberately — same as the lists query above.
    // This is the screen where an archived folder is un-archived, so filtering it
    // out here would make that impossible from the only place it is offered.
    supabase
      .from("vizserve_pms_task_groups")
      .select("id, name, description, department_id, is_active, sort_order, is_system")
      .order("sort_order")
      .order("name"),
  ]);

  /*
   * Which departments the pickers on this screen may file a folder or list
   * under.
   *
   * P8-01c: `departmentShapeScope`, not `managedDepartmentIds`. The managed set
   * is what somebody LEADS, and a department admin leads nothing — they
   * administer the team they belong to. Filtering on the managed set alone gave
   * a member holding the tick an empty department picker on a screen they can
   * now open, which is a dead end rather than a refusal.
   *
   * ⚠️ NOT `departmentPickerScope`. That one is derived from the approval and
   * visibility scope, which P8-01 deliberately left alone — see the note on
   * `departmentShapeScope`.
   */
  const scope = departmentShapeScope(context);
  const allowed =
    scope.kind === "all"
      ? (departments ?? [])
      : scope.kind === "none"
        ? []
        : (departments ?? []).filter((department) => scope.ids.includes(department.id));

  // How many tasks each list holds, so nobody archives a list that is carrying
  // live work without knowing.
  const { data: taskCounts } = await supabase
    .from("vizserve_pms_tasks")
    .select("list_id")
    .not("list_id", "is", null)
    .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)");

  const openByList = new Map<string, number>();
  for (const row of taskCounts ?? []) {
    if (!row.list_id) continue;
    openByList.set(row.list_id, (openByList.get(row.list_id) ?? 0) + 1);
  }

  return (
    <PageShell className="mx-auto w-full max-w-4xl">
      <div>
        <Link
          href="/tasks"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Tasks
        </Link>
        {/* No <h1> — the breadcrumb reads "Tasks / Lists". */}
        <p className="mt-2 text-xs text-muted-foreground">
          How a department groups its work. A folder holds lists; a list holds tasks; a list can
          also sit on its own. Every form gets a list of its own in Client Requests, which is
          where approved requests land.
        </p>
      </div>

      <ListManager
        lists={lists ?? []}
        groups={groups ?? []}
        departments={allowed}
        openCounts={Object.fromEntries(openByList)}
      />
    </PageShell>
  );
}

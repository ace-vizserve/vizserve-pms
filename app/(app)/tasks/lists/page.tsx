import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import {
  canManageAnyDepartmentTree,
  departmentTreeScope,
  ForbiddenError,
  requireAuthContext,
} from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";

import { ListManager } from "./list-manager";

export const metadata: Metadata = { title: "Lists" };

/**
 * P3-01 / P12-16 — managing lists: the SERVER half, which is auth and the
 * department scope and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO CARRY THE WHOLE SCREEN'S DATA — four queries whose
 * results became four props, re-run in full by `revalidatePath("/tasks/lists")`
 * every time somebody renamed a list. P12-16 moved them into the TanStack cache
 * (`list-manager.tsx`, `lib/query/fetchers/lists.ts`) and left behind exactly
 * the two things that must not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase. It also runs in `app/(app)/layout.tsx` above this;
 *      calling it here is what gives this file the CONTEXT, not what enforces
 *      the gate.
 *   2. THE DEPARTMENT SCOPE. `departmentTreeScope` lives in a `server-only`
 *      module, so which departments this person may file a folder or list under
 *      has to be resolved on this side of the wire and travel as a prop. That is
 *      the same rule `/tasks` follows with its `viewer` — a client component
 *      deciding its own scope is precisely the "scattered `if (role ===
 *      'admin')`" CLAUDE.md exists to forbid.
 *
 * ⚠️ ONE QUERY SURVIVES HERE AND IT IS THE DEPARTMENTS, because it is the scope
 * itself: `allowed` is the intersection of what RLS returns with what the tree
 * scope permits, and the second half is server-only. It is the same read the
 * client cache files as `qk.ref("departments")`; running it here is what makes
 * the *filtered* list a fact this file is willing to assert rather than a rule
 * the browser reapplies.
 * ------------------------------------------------------------------------
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
  /*
   * P11-07 — WAS `requireDepartmentShape()`, WHICH THREW AT A MEMBER.
   *
   * `/tasks` redirects here when it carries no `?list=`, so this gate was not
   * merely hiding a screen: it was the dead end behind every bare link to the
   * tasks area. A member following one got "This area is for team leaders and
   * department admins."
   *
   * `p11_07` made the tree the department's, so the gate is now only about
   * having a department at all — the one case where this page would open on an
   * empty picker and a New list button that cannot be satisfied. Everything
   * below is RLS-scoped anyway; this decides whether it is worth rendering.
   */
  const context = await requireAuthContext();
  if (!canManageAnyDepartmentTree(context)) {
    throw new ForbiddenError("You are not in a department yet, so there is nothing to organise.");
  }
  const supabase = await createClient();

  // RLS-scoped: a TL sees the departments they lead. No `.in()` needed, and
  // restating it here would imply the policy were optional.
  const { data: departments } = await supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

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
  const scope = departmentTreeScope(context);
  const allowed =
    scope.kind === "all"
      ? (departments ?? [])
      : scope.kind === "none"
        ? []
        : (departments ?? []).filter((department) => scope.ids.includes(department.id));

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

      <ListManager departments={allowed} />
    </PageShell>
  );
}

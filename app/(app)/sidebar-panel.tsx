import { loadActiveDepartments, loadManagedDepartmentNames } from "@/lib/departments-server";
import {
  canAdminDepartment,
  canDoHr,
  canShapeAnyDepartment,
  canShapeDepartment,
  type AuthContext,
} from "@/lib/auth/authorization";
import { groupedNavItems } from "@/lib/navigation";
import { fetchSidebarSnapshot } from "@/lib/query/fetchers/snapshot";
import type { SidebarSnapshot } from "@/lib/schemas/sidebar";
import { createClient } from "@/utils/supabase/server";

import { SidebarFromSnapshot } from "./sidebar-snapshot";

/**
 * P11-05 / P12-01 — THE RAIL'S OWN DATA, OFF THE PAGE'S CRITICAL PATH.
 *
 * Behind a Suspense boundary in the layout, so `children` never waits for it.
 *
 * ⚠️ P12-01 TOOK NINE QUERIES DOWN TO THREE. The badges, the project tree, its
 * per-list counts and the Personal group are one `SECURITY INVOKER` RPC,
 * `vizserve_pms_sidebar_snapshot()`, which counts in Postgres instead of
 * downloading a row per open task. The other two reads are the user menu's
 * led departments and the active-department list the reorder permission is
 * computed over — both keyed on `AuthContext`, which the browser never holds.
 *
 * ⚠️ THE SNAPSHOT IS READ HERE AND AGAIN IN THE BROWSER. Here, so the first
 * paint is server-rendered as before; in the browser (`sidebar-snapshot.tsx`),
 * so a realtime ping can move a badge by refetching one RPC rather than
 * re-rendering the route.
 *
 * ⚠️ `requireAuthContext()` DELIBERATELY STAYS IN THE LAYOUT BODY. It is the
 * temporary-password wall, the app-access gate and the deactivation check — the
 * redirects have to happen BEFORE anything paints.
 */
export async function SidebarPanel({ context }: { context: AuthContext }) {
  // P7-52. `canDoHr`, not `context.isHr` — an owner holds the capability
  // without carrying the flag, and passing the raw column would hide the HR
  // section from every owner while the database still let them use it.
  //
  // P8-01 adds `isDeptAdmin` on the same principle, resolved against the
  // person's OWN department because that is the only one the tick can apply to
  // and the nav can only ask "do they administer anything at all".
  //
  // P8-01c is what finally reads it: the Forms row carries `alsoDeptAdmin`, so
  // a MEMBER holding the tick now sees the builder in the rail.
  const sections = groupedNavItems(context.role, {
    isHr: canDoHr(context),
    isDeptAdmin: canAdminDepartment(context, context.primaryDepartmentId),
  });

  const supabase = await createClient();

  const [departmentNames, departments, snapshot] = await Promise.all([
    // The departments this person leads, for the user menu. The loader returns
    // `[]` without a query for a plain member — `.in("id", [])` matches nothing.
    loadManagedDepartmentNames(context.managedDepartmentIds),
    loadActiveDepartments(),
    /*
     * ⚠️ A FAILED READ IS `null`, NOT AN EMPTY SNAPSHOT. The browser query then
     * starts with no data and fetches for itself, drawing the skeleton while it
     * does — rather than a confident empty tree. The fetcher has already
     * logged it.
     */
    fetchSidebarSnapshot(supabase).catch((): SidebarSnapshot | null => null),
  ]);

  return (
    <SidebarFromSnapshot
      sections={sections}
      initialSnapshot={snapshot}
      // A server component renders once per request, so this is the fact being
      // reported, not an impure render. See `useAdoptServerSnapshot`.
      // eslint-disable-next-line react-hooks/purity -- see the note above
      serverRenderedAt={Date.now()}
      /*
       * P7-74 — per department, because a lead of VizBytes may drag VizBytes'
       * folders and not VizMedia's. `reorderLists` and `reorderTaskGroups` ask
       * the same predicate server-side, so this is the button, not the gate.
       * P13-01 deliberately does not widen it for the collaboration space.
       */
      reorderableDepartmentIds={departments
        .filter((department) => canShapeDepartment(context, department.id))
        .map((department) => department.id)}
      sharedDepartmentIds={context.sharedDepartmentIds}
      /*
       * ⚠️ TEAM LEADERS, MANAGERS AND ADMINS. NOT EVERY MEMBER.
       *
       * Amier, 21 Sep: "for the manage lists only tl manager and admin only".
       *
       * ⚠️ THIS WAS BRIEFLY `canManageAnyDepartmentTree` AND THAT WAS WRONG.
       * The reasoning was that P11-07 opened the `/tasks/lists` PAGE to any
       * member, so the rail was hiding a link to a screen that would have let
       * them in — true, and not this component's call to make. P13-01 was
       * scoped to the collaboration space; quietly putting "Manage lists" in
       * front of every person in the company for every department they belong
       * to is a change to a different feature, made on the way past.
       *
       * ⚠️ SO THE RAIL AND THE PAGE DISAGREE ON PURPOSE, and the direction is
       * the safe one: the rail is narrower. A member who reaches `/tasks/lists`
       * by URL is still admitted, because P11-07's policies still admit them —
       * the link simply is not offered. Tightening the PAGE would mean
       * reversing P11-07 itself, policies included, which is its own decision.
       *
       * `canShapeAnyDepartment` is team_leader-or-above, plus the department
       * Admin tick (P8-01c) — which is the "admin" of that sentence at member
       * rank, and the capability that tick exists to confer.
       */
      canManageLists={canShapeAnyDepartment(context)}
      user={{
        fullName: context.fullName,
        email: context.email,
        role: context.role,
        departments: departmentNames,
      }}
    />
  );
}

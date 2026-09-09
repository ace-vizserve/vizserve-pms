import {
  canAdminDepartment,
  canDoHr,
  canShapeAnyDepartment,
  type AuthContext,
} from "@/lib/auth/authorization";
import { groupedNavItems } from "@/lib/navigation";
import { createClient } from "@/utils/supabase/server";

import { SidebarFromSnapshot } from "./sidebar-snapshot";

/**
 * P11-05 / P12-01 — THE RAIL'S OWN DATA, OFF THE PAGE'S CRITICAL PATH.
 *
 * ⚠️ THIS USED TO BE EIGHT AWAITED QUERIES IN THE LAYOUT BODY, WHICH MEANT THE
 * PAGE COULD NOT RENDER UNTIL THE SIDEBAR HAD FINISHED. Not just on first load:
 * `router.refresh()` re-renders layouts too, and every mutation in this app ends
 * with one — so after every status change, every punch and every timesheet cell,
 * the whole content area waited on the project tree before it could repaint.
 * P11-05 put it behind a Suspense boundary so `children` no longer waits.
 *
 * ⚠️ P12-01 TOOK NINE QUERIES DOWN TO ONE, AND MOVED IT TO THE BROWSER. The
 * eight-in-one-wave batch that used to live in this file is now a single
 * `vizserve_pms_sidebar_snapshot()` call made from the query cache — see
 * `sidebar-snapshot.tsx` and the migration. What that fixes is not speed: it is
 * that every read in the old batch ended in `?? []` or `?? 0`, so a burst
 * failure rendered an EMPTY project tree and zeroed badges with nothing on
 * screen admitting it, and that the only way the rail ever got new numbers was a
 * full server render — which is why completing a task emptied every count until
 * a hard refresh.
 *
 * ⚠️ `requireAuthContext()` DELIBERATELY STAYS IN THE LAYOUT BODY rather than
 * moving in here. It is two reads and it is the temporary-password wall, the
 * app-access gate and the deactivation check — the redirects have to happen
 * BEFORE anything paints, or somebody who must change their password sees the
 * whole app frame flash on every single sign-in. Fast and blocking is the right
 * shape for a gate; slow and streamed is the right shape for a nav tree. P12-01
 * does not touch it, and no phase of the SPA migration does.
 *
 * WHAT IS LEFT ON THE SERVER, and why each of the three is here rather than in
 * the snapshot: they are all decided by `context`, which the browser never
 * receives and must not. The nav sections, `canManageLists` and the user card
 * are authorization output, not data.
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

  /*
   * THE ONE QUERY THAT DID NOT MOVE INTO THE SNAPSHOT.
   *
   * The departments this person LEADS, shown in the user menu because it is the
   * thing that decides the contents of every list they open, and is otherwise
   * invisible. It is keyed on `context.managedDepartmentIds`, which is
   * authorization output the browser does not hold — putting it in the snapshot
   * would mean the RPC deciding what somebody leads, which is a scope decision,
   * and scope decisions live in `lib/auth/authorization.ts` and in RLS.
   *
   * ⚠️ STILL CONDITIONAL, and it has to be. `.in("id", [])` is a filter that
   * matches nothing, which is the trap written out at length above
   * `departmentPickerScope` — a plain member leads nothing, so the query is not
   * built at all.
   */
  const supabase = await createClient();

  const managedDepartments =
    context.managedDepartmentIds.length > 0
      ? await supabase
          .from("vizserve_pms_departments")
          .select("name")
          .in("id", context.managedDepartmentIds)
          .order("name")
      : null;

  /*
   * ⚠️ `?? []` SURVIVES HERE, AND IT IS THE LEGAL KIND — the distinction P12-01
   * is a sweep for.
   *
   * Everywhere else that fallback hid a failure behind a state the reader could
   * not tell apart from success. Here the empty case is not merely legal, it is
   * the COMMON one: a plain member leads no departments, the query above is not
   * issued at all, and the user menu correctly lists nothing. There is no
   * distinguishable "failed" rendering to lose, because the honest empty and the
   * failed empty are the same three words of nothing under a name — and this
   * decorates a menu rather than reporting a number anybody acts on.
   *
   * If it is ever promoted into the snapshot, it stops being this and has to
   * throw like every other read there.
   */
  const departmentNames = (managedDepartments?.data ?? []).map((row) => row.name);

  return (
    <SidebarFromSnapshot
      sections={sections}
      /*
       * ⚠️ THE OLD REFRESH SIGNAL, FORWARDED — and it is STILL load-bearing
       * after P12-09, which is not what the plan said would happen twice over.
       *
       * Phase 2 was meant to retire this once `use-realtime-refresh.ts` stopped
       * calling `router.refresh()`; P12-09 was meant to retire it once the task
       * controls stopped too. Both have happened and this stays, for a reason
       * that is now about the OTHER domains rather than about tasks: lists,
       * requests, approvals, the inbox, the timesheet and DTR all write through
       * Server Actions that touch the query cache nowhere, and the rail carries
       * a count for every one of them. The full argument is above
       * `useRefetchOnServerRender` in `sidebar-snapshot.tsx`; it goes when the
       * last of those is converted (Phases 4–6).
       *
       * Those mutations end in `revalidatePath`, which re-runs this server
       * component. That is how the rail's counts move for them. A re-render does
       * NOT remount a client component, so the query inside one would never be
       * asked to refetch and approving a request would leave the count where it
       * was. A fresh number on every server render is the signal;
       * `useRefetchOnServerRender` turns it into one invalidation. No timer, no
       * poll — and after P12-09 a task click does not produce one at all,
       * because nothing re-renders this component any more.
       *
       * ⚠️ `react-hooks/purity` IS SUPPRESSED HERE, DELIBERATELY AND EXACTLY
       * ONCE. The rule is right about client components: an impure call during
       * render produces a value that changes whenever React happens to
       * re-render, which is unpredictable. This is an async SERVER component. It
       * runs once per request, it cannot re-render on its own, and "a different
       * number every time the server rendered" is not a side effect here — it is
       * the entire fact being reported. Suppressing it beats hiding the same
       * call inside a helper the linter cannot see through, which would be the
       * same evasion with the reason removed.
       */
      // eslint-disable-next-line react-hooks/purity -- see the note above
      serverRenderedAt={Date.now()}
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

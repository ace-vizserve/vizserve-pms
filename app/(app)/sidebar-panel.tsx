import {
  canAdminDepartment,
  canDoHr,
  canShapeAnyDepartment,
  type AuthContext,
} from "@/lib/auth/authorization";
import { groupedNavItems } from "@/lib/navigation";
import { formatNavBadge } from "@/lib/navigation";
import { createClient } from "@/utils/supabase/server";
import { AppSidebar } from "@/components/app-shell/app-sidebar";

/**
 * P11-05 — THE RAIL'S OWN DATA, OFF THE PAGE'S CRITICAL PATH.
 *
 * ⚠️ THIS USED TO BE EIGHT AWAITED QUERIES IN THE LAYOUT BODY, WHICH MEANT THE
 * PAGE COULD NOT RENDER UNTIL THE SIDEBAR HAD FINISHED. Not just on first load:
 * `router.refresh()` re-renders layouts too, and every mutation in this app ends
 * with one — so after every status change, every punch and every timesheet cell,
 * the whole content area waited on the project tree before it could repaint.
 *
 * Behind a Suspense boundary, `children` no longer waits for any of it. The
 * queries are unchanged, still one wave, still policy-scoped; what changed is
 * that the page renders alongside them instead of after them.
 *
 * ⚠️ `requireAuthContext()` DELIBERATELY STAYS IN THE LAYOUT BODY rather than
 * moving in here. It is two reads and it is the temporary-password wall, the
 * app-access gate and the deactivation check — the redirects have to happen
 * BEFORE anything paints, or somebody who must change their password sees the
 * whole app frame flash on every single sign-in. Fast and blocking is the right
 * shape for a gate; slow and streamed is the right shape for a nav tree.
 *
 * The context is passed as a prop. Server component to server component, so
 * nothing is serialised and nothing crosses to the browser that did not before.
 */
/**
 * Pairs a formatted count with what it counts.
 *
 * The description is read only by a screen reader, which would otherwise
 * announce "Requests 1" — a number with no noun, folded into the link name.
 * Null passes straight through, so a zero count still renders no badge.
 */
function labelledBadge(
  value: string | null,
  description: string,
): { value: string; description: string } | null {
  return value === null ? null : { value, description };
}

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

  /*
   * ⚠️ ONE WAVE, NOT FOUR. Every read below depends only on `context`, which is
   * already in hand — and yet the user-menu departments, the unread badge, the
   * Requests badge and the project tree used to run as four sequential awaits,
   * each one not even issued until the one before it had come back. Four
   * blocking round trips in the SHELL, which is the one component every single
   * authenticated page in the app renders before it starts its own queries.
   *
   * None of them reads another's result — the two badges are `head: true`
   * counts, the tree is assembled below from its own five reads, and the
   * department names are keyed on `context.managedDepartmentIds` — so they all
   * go together and the shell's depth drops from four waves to one. Nothing
   * about the queries, the filters or the fallbacks moves.
   *
   * ⚠️ EIGHT IN FLIGHT HERE, AND ABOUT TWENTY PER NAVIGATION. The shell's own
   * count is the reassuring number and it is not the one that matters — the
   * layout and the page render CONCURRENTLY, so what the socket pool sees is
   * the sum. On `/tasks/[id]`, the heaviest route, that is 8 here + 12 in the
   * page + 2 in `resolveAuth`. It was roughly 14 before this change, because
   * the four sequential waves were accidentally rate-limiting.
   *
   * The ceiling is real — see the note beside `<ShiftReminder />` further down.
   * Feeding that component from here once put `loadPunchState`'s six queries
   * plus a preferences read on top of this batch and the combined burst started
   * failing with `TypeError: fetch failed`, at roughly a dozen concurrent.
   * Twenty is past that. It is shipped deliberately, not because it is
   * comfortably under the limit: the shell's own eight is below the twelve that
   * broke, two of them are `head: true` counts that ship no rows, and undici's
   * `fetch failed` is socket-burst behaviour rather than a fixed PostgREST cap
   * — so it is load-dependent rather than certain.
   *
   * ⚠️ THE SYMPTOM WILL NOT BE AN ERROR PAGE. Every read in this batch degrades
   * to `?? []` or `?? 0`, so a burst failure renders an EMPTY project tree or a
   * zeroed badge and nothing else — a silent partial render, which is the worst
   * version of this to diagnose. Watch the dev-server log for `fetch failed`
   * with `ECONNRESET` / `UND_ERR_SOCKET` on `/tasks/[id]`, `/` and
   * `/timesheet/team` before trusting an empty sidebar.
   *
   * ⚠️ THE FIX IF IT COMES BACK, cheapest first. Do NOT unwind the tree.
   *   1. Split this batch in two: the two badges and the two department reads,
   *      then the four tree reads. Peak 4, one extra round trip instead of the
   *      three this removed. A six-line edit and it keeps most of the win.
   *   2. Failing that, `git revert` this file alone — nothing else depends on
   *      its shape.
   *   3. If it shows on a PAGE rather than the shell, the 12-entry batch in
   *      `app/(app)/tasks/[id]/page.tsx` is the largest in the product and is
   *      the first place to split.
   */

  // The departments this person leads. Shown in the user menu because it is the
  // thing that decides the contents of every list they open, and is otherwise
  // invisible.
  //
  // ⚠️ STILL CONDITIONAL, and it has to be. `.in("id", [])` is a filter that
  // matches nothing, which is the trap written out at length above
  // `departmentPickerScope` — a plain member leads nothing, so the query is not
  // built at all and a plain `null` rides through the batch in its place.
  const managedDepartmentsQuery =
    context.managedDepartmentIds.length > 0
      ? supabase
          .from("vizserve_pms_departments")
          .select("name")
          .in("id", context.managedDepartmentIds)
          .order("name")
      : null;

  const [
    managedDepartments,
    { count: unread },
    { count: awaitingReview },
    { data: departments },
    { data: lists },
    { data: groups },
    { data: openTasks },
    { data: pendingRequests },
    { data: myLists },
  ] = await Promise.all([
    managedDepartmentsQuery,

    // The unread badge, deferred at P0-10 (Amier, 21:20) and asked for since.
    //
    // `head: true` — a count with no rows, so this costs one indexable aggregate
    // per navigation rather than shipping notification bodies the shell never
    // renders. RLS scopes it to the caller, so there is no user filter here.
    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),

    /*
     * P7-50 — the Requests badge: how many are sitting at Gate 1.
     *
     * PENDING_REVIEW only. That is the one status where somebody is WAITING on a
     * decision from whoever is reading the sidebar — approved, returned and
     * rejected have all had their answer, and counting them would make the badge
     * a total rather than a to-do.
     *
     * NO SCOPE FILTER, exactly as the unread count above. The policy on
     * `vizserve_pms_requests` already decides what the caller can see, so a Team
     * Leader gets their departments and an admin gets everyone — restating the
     * filter here would imply the policy is optional, which is the rule this
     * codebase enforces everywhere else.
     *
     * `head: true` — one indexable aggregate per navigation, no rows shipped.
     */
    supabase
      .from("vizserve_pms_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING_REVIEW"),

    /*
     * The project tree — Department → Folder → List (P7-18).
     *
     * NO SCOPE FILTER ON ANY OF THESE QUERIES. Departments, lists and folders all
     * scope by policy, so a member gets their own department's tree and an admin
     * gets every one from the same queries — restating the rule here would imply
     * the policies were optional.
     *
     * The task counts are a separate query rather than a join, because PostgREST
     * cannot aggregate a related table and a per-list count would be an N+1 in the
     * SHELL — the one component on every single page in the app.
     */
    supabase
      .from("vizserve_pms_departments")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
    // `sort_order` first, to agree with /tasks/lists — which has always
    // ordered that way while this query silently did not.
    supabase
      .from("vizserve_pms_lists")
      .select("id, name, department_id, group_id")
      /*
       * ⚠️ P11-06 — THE ONE EXCEPTION TO THE "NO SCOPE FILTER" NOTE ABOVE, and
       * it is not a scope filter. It shipped without this line and the result
       * was the bug Amier reported on 8 Sep: your own personal list appearing
       * TWICE in the rail — once under Personal lists where it belongs, and
       * once under your department in the project tree, as a folderless list
       * with an open-task count beside it.
       *
       * The note above is still right about scope and that is exactly why this
       * is needed. `personal lists belong to their owner` DOES return your own
       * personal lists to you, correctly — the policy is not the thing being
       * second-guessed here. What this excludes is a KIND of list, not a set of
       * rows somebody may not see: a personal list carries a department (it has
       * to; see the migration) but is not part of that department's shape. It
       * is in no folder, nobody else can see it, and the tree above it is
       * explicitly where the DEPARTMENT'S work lives.
       *
       * The distinction matters for the next person: restating a POLICY here
       * would be wrong, and this is not that. Nobody else's tree changes by one
       * row — for every other reader `owner_id` was already null on everything
       * they could see.
       */
      .is("owner_id", null)
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
    supabase
      .from("vizserve_pms_task_groups")
      .select("id, name, department_id, is_system")
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
    // Live work only. A count including everything ever finished would grow
    // forever and stop meaning "how much is in here".
    supabase
      .from("vizserve_pms_tasks")
      .select("list_id")
      .not("list_id", "is", null)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)"),
    /*
     * P7-26 — client requests waiting on Gate 1, counted per list.
     *
     * A pending request has no task and therefore no `list_id`; where it WILL
     * land is the form's inbox list, so the count is grouped through the form.
     * `!inner` because a request whose form has gone has nowhere to be
     * counted.
     *
     * This is the number that stops a request sitting unlooked-at for a week:
     * the folder it belongs to says so in the rail, on every page.
     *
     * Returns nothing for a member — `vizserve_pms_requests` is lead-only, so
     * the badge simply never appears for them and no role check is needed.
     */
    supabase
      .from("vizserve_pms_requests")
      .select("vizserve_pms_forms!inner(default_list_id)")
      .eq("status", "PENDING_REVIEW"),

    /*
     * P11-06 — the reader's own lists, for the Personal group.
     *
     * ⚠️ A NINTH QUERY RATHER THAN A COLUMN ON THE LISTS READ ABOVE, AND THAT IS
     * THE POINT. Adding `owner_id` to that query and splitting the rows here
     * would have made the project tree — the thing every person in the company
     * looks at all day — depend on this feature parsing correctly. It does not.
     * The tree's query is byte-for-byte what it was; a failure here empties the
     * Personal group and nothing else.
     *
     * ⚠️ NO `is_active` FILTER, unlike every other lists read in this app. The
     * Personal group shows archived lists behind a disclosure, because the only
     * screen that could otherwise un-archive one is `/tasks/lists`, which is
     * department-scoped and refuses a plain member — so filtering here would
     * make archiving a one-way door.
     *
     * The `owner_id` filter is BELT AND BRACES, not the enforcement: `personal
     * lists belong to their owner` is the only policy that admits an owned row,
     * so the caller could not read anybody else's regardless. It is stated
     * because this query would otherwise also return every DEPARTMENT list a
     * second time, which is a correctness bug rather than a security one.
     */
    supabase
      .from("vizserve_pms_lists")
      .select("id, name, is_active")
      .eq("owner_id", context.userId)
      .order("sort_order")
      .order("name"),
  ]);

  const departmentNames = (managedDepartments?.data ?? []).map((row) => row.name);

  const countByList = new Map<string, number>();
  for (const task of openTasks ?? []) {
    if (!task.list_id) continue;
    countByList.set(task.list_id, (countByList.get(task.list_id) ?? 0) + 1);
  }

  // Same shape as the task count above, keyed by the list the request will land
  // in rather than one it is already in.
  const pendingByList = new Map<string, number>();
  for (const row of (pendingRequests ?? []) as unknown as {
    vizserve_pms_forms: { default_list_id: string | null } | null;
  }[]) {
    const listId = row.vizserve_pms_forms?.default_list_id;
    if (!listId) continue;
    pendingByList.set(listId, (pendingByList.get(listId) ?? 0) + 1);
  }

  const toList = (list: { id: string; name: string }) => ({
    id: list.id,
    name: list.name,
    openTasks: countByList.get(list.id) ?? 0,
    pendingRequests: pendingByList.get(list.id) ?? 0,
  });

  const spaces = (departments ?? [])
    .map((department) => {
      const own = (lists ?? []).filter((list) => list.department_id === department.id);

      const folders = (groups ?? [])
        .filter((group) => group.department_id === department.id)
        .map((group) => {
          const folderLists = own.filter((list) => list.group_id === group.id).map(toList);
          return {
            id: group.id,
            name: group.name,
            isSystem: group.is_system,
            lists: folderLists,
            // Rolled up, so a collapsed folder still says how much is inside.
            openTasks: folderLists.reduce((total, list) => total + list.openTasks, 0),
            pendingRequests: folderLists.reduce((total, list) => total + list.pendingRequests, 0),
          };
        })
        // THE RESERVED FOLDER IS DROPPED WHILE EMPTY, and only that one. The
        // migration's backfill gives every department a Client Requests folder,
        // so without this every team grows a permanently empty section the day
        // the SQL is pasted. An empty folder somebody MADE is kept — otherwise
        // it vanishes the moment they create it, and the way to put a list in it
        // is unreachable.
        .filter((folder) => !folder.isSystem || folder.lists.length > 0)
        // System folder last, tie-broken on the flag rather than on sort_order,
        // which a lead could out-bid.
        .sort((a, b) => Number(a.isSystem) - Number(b.isSystem));

      return {
        departmentId: department.id,
        departmentName: department.name,
        // Folderless lists — ClickUp's own term, and what EVERY list is until
        // somebody makes a folder. They render above the folders for that
        // reason: folders-first would bury the whole company's work under a
        // heading on the day P7-18 landed.
        lists: own.filter((list) => list.group_id === null).map(toList),
        folders,
      };
    })
    // A department with nothing in it opens onto nothing. Dropped rather than
    // shown empty — the tree is for navigating to work, and an admin sees every
    // department in the company here. The group itself still renders, carrying
    // the "Create a list" row, so the feature is reachable before anybody has
    // made one.
    .filter((space) => space.lists.length > 0 || space.folders.length > 0);

  /*
   * P11-06. `?? []` like every other read in this batch — a failure here renders
   * an empty Personal group and leaves the tree above it alone.
   */
  const personalLists = (myLists ?? []).map((list) => ({
    id: list.id,
    name: list.name,
    isActive: list.is_active,
  }));

  return (
    <AppSidebar
      sections={sections}
      badges={{
        "/inbox": labelledBadge(formatNavBadge(unread ?? 0), "unread"),
        "/requests": labelledBadge(formatNavBadge(awaitingReview ?? 0), "awaiting review"),
      }}
      spaces={spaces}
      canManageLists={canShapeAnyDepartment(context)}
      personalLists={personalLists}
      user={{
        fullName: context.fullName,
        email: context.email,
        role: context.role,
        departments: departmentNames,
      }}
    />
  );
}

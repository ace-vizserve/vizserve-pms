import {
  canAdminDepartment,
  canDoHr,
  canShapeAnyDepartment,
  requireAuthContext,
} from "@/lib/auth/authorization";
import { groupedNavItems } from "@/lib/navigation";
import { formatNavBadge } from "@/lib/navigation";
import { createClient } from "@/utils/supabase/server";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import {
  BreadcrumbLabelProvider,
  DynamicBreadcrumb,
} from "@/components/app-shell/dynamic-breadcrumb";
import { RealtimeNotifications } from "@/components/realtime-refresh";
import { ShiftReminder } from "@/components/shift-reminder";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

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

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await requireAuthContext();
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

  // The departments this person leads. Shown in the user menu because it is the
  // thing that decides the contents of every list they open, and is otherwise
  // invisible.
  let departmentNames: string[] = [];
  if (context.managedDepartmentIds.length > 0) {
    const { data } = await supabase
      .from("vizserve_pms_departments")
      .select("name")
      .in("id", context.managedDepartmentIds)
      .order("name");
    departmentNames = (data ?? []).map((row) => row.name);
  }

  // The unread badge, deferred at P0-10 (Amier, 21:20) and asked for since.
  //
  // `head: true` — a count with no rows, so this costs one indexable aggregate
  // per navigation rather than shipping notification bodies the shell never
  // renders. RLS scopes it to the caller, so there is no user filter here.
  const { count: unread } = await supabase
    .from("vizserve_pms_notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

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
  const { count: awaitingReview } = await supabase
    .from("vizserve_pms_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "PENDING_REVIEW");

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
  const [
    { data: departments },
    { data: lists },
    { data: groups },
    { data: openTasks },
    { data: pendingRequests },
  ] = await Promise.all([
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

    ]);

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

  return (
    <TooltipProvider>
      <BreadcrumbLabelProvider>
        {/*
          P8-03 — the unread badge above stops being a number that was only true
          at the moment this layout last rendered.

          IN THE SHELL, NOT ON /inbox, because the badge is in the shell: a
          notification arriving while somebody is on the board has to move the
          count in the rail, and a subscription mounted on the inbox page would
          only fire for the one person already looking at it.

          Renders nothing. It subscribes to `vizserve_pms_notifications` filtered
          to `user_id=eq.<me>` — the same predicate as the "notifications read
          own" policy — and calls `router.refresh()`, which re-runs THIS server
          component and therefore re-runs the `count` query above. No count is
          computed in the browser and there is no second source of truth for it.
        */}
        <RealtimeNotifications userId={context.userId} />

        {/*
          P8-12 — the clock reminder, mounted beside the realtime badge for the
          same reason: it renders nothing, it needs a browser timer, and it has
          to be live on EVERY page. A reminder that only fires while somebody is
          looking at their own time record is a reminder for the one person who
          does not need it.

          ⚠️ IT TAKES NO PROPS AND THIS LAYOUT READS NOTHING FOR IT — a
          correction, not the original design. It was first fed from here, which
          put `loadPunchState`'s six queries plus a preferences read on the
          critical path of EVERY authenticated page. `/timesheet` and `/dtr`
          issue large batches of their own, and the combined burst started
          failing with `TypeError: fetch failed`. The component fetches its own
          state after mount now; see `app/(app)/reminder-actions.ts`.
        */}
        <ShiftReminder />

        <SidebarProvider>
          <AppSidebar
            sections={sections}
            badges={{
              "/inbox": labelledBadge(formatNavBadge(unread ?? 0), "unread"),
              "/requests": labelledBadge(
                formatNavBadge(awaitingReview ?? 0),
                "awaiting review",
              ),
            }}
            spaces={spaces}
            canManageLists={canShapeAnyDepartment(context)}
            user={{
              fullName: context.fullName,
              email: context.email,
              role: context.role,
              departments: departmentNames,
            }}
          />

          <SidebarInset>
            {/*
              h-14 and frosted, per the design refresh. The bar is translucent
              (`bg-panel`) with a blur behind it, so rows visibly pass UNDER it
              rather than being hidden by it — which is the point of a sticky
              header on a list that runs to hundreds of rows.

              That translucency is why it now carries a border and a shadow.
              The previous version was opaque and borderless, and relied on the
              opacity alone to separate itself from what slid beneath. A frosted
              bar cannot do that, so `shadow-chrome` supplies the lit top edge
              and the soft cast, and `border-b` the hairline.

              STICKY: the breadcrumb is how you know where you are, and on a
              long list it used to scroll away and take the sidebar toggle and
              theme switch with it.
            */}
            <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-panel shadow-chrome backdrop-blur-md backdrop-saturate-150">
              <div className="flex items-center gap-2 px-4.5">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                />
                <DynamicBreadcrumb />
              </div>

              <div className="ml-auto flex items-center gap-2 pr-4.5">
                <ThemeToggle />
              </div>
            </header>

            {/* The one gradient in the product UI: a broad, very low-contrast wash so
                panels have something to cast onto instead of sitting on a flat slab. */}
            <main className="flex flex-1 flex-col grade-ambient bg-no-repeat">{children}</main>
          </SidebarInset>
        </SidebarProvider>
      </BreadcrumbLabelProvider>
    </TooltipProvider>
  );
}

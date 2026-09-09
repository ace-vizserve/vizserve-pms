"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AppSidebar, type SidebarSection } from "@/components/app-shell/app-sidebar";
import { AppSidebarSkeleton } from "@/components/app-shell/app-sidebar-skeleton";
import type { ProjectList, ProjectSpace } from "@/components/app-shell/nav-projects";
import { formatNavBadge } from "@/lib/navigation";
import { browserClient } from "@/lib/query/browser-client";
import { fetchSidebarSnapshot } from "@/lib/query/fetchers/snapshot";
import { qk } from "@/lib/query/keys";
import type { SidebarSnapshot } from "@/lib/schemas/sidebar";

/**
 * P12-01 — the rail, read from the query cache instead of the server.
 *
 * ⚠️ THE BUG THIS FIXES IS NOT "THE SIDEBAR IS SLOW". Complete a task and every
 * count in the rail used to drop to nothing until a hard refresh, because the
 * only way the shell got new numbers was a full server render of the layout —
 * and when a burst of concurrent PostgREST requests failed with
 * `TypeError: fetch failed`, every read in `sidebar-panel.tsx` degraded to
 * `?? []` or `?? 0` and the tree simply came back EMPTY. A silent partial
 * render, with nothing on screen admitting it. One query, one key, and a
 * failure that throws is the whole of the fix.
 *
 * ⚠️ WHAT STAYED ON THE SERVER, AND WHY IT MUST. `requireAuthContext()` is the
 * temporary-password wall, the `app_access` gate and the deactivation check; it
 * runs in `app/(app)/layout.tsx` before anything paints and it does not move.
 * Everything derived from it — the role-filtered nav, the user card, whether
 * `/tasks/lists` is reachable — is computed in `sidebar-panel.tsx` and arrives
 * here as props. Authentication does not go through the cache, and no decision
 * about what somebody may see is made in this file.
 *
 * ⚠️ `AppSidebar`'S PROPS ARE UNCHANGED. This component is a data source, not a
 * redesign: it fetches, shapes nothing (the SQL emits the prop shapes verbatim)
 * and hands the same object the server component used to hand it.
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

/**
 * Blanks every count in a space, keeping the tree itself.
 *
 * ⚠️ ONLY USED WHILE A REFETCH IS FAILING OVER DATA WE ALREADY HAVE, and the
 * asymmetry is deliberate. The LISTS in a stale snapshot are still true — teams
 * do not gain and lose lists between two refetches — but the COUNTS are the
 * volatile half, and the one event most likely to have moved them is the very
 * thing that triggered the refetch: somebody completed a task. Showing the old
 * number there is showing a number nobody can stand behind, and per Phase 1 the
 * cure for that is to say so rather than to print it. `FolderCounts` renders
 * `null` as a dimmed dash with `count unavailable` beside it for a screen
 * reader — visibly not a zero, which is what the old `?? 0` produced.
 */
function withUnknownCounts(space: ProjectSpace): ProjectSpace {
  const blank = (list: ProjectList): ProjectList => ({
    ...list,
    openTasks: null,
    pendingRequests: null,
  });

  return {
    ...space,
    lists: space.lists.map(blank),
    folders: space.folders.map((folder) => ({
      ...folder,
      lists: folder.lists.map(blank),
      openTasks: null,
      pendingRequests: null,
    })),
  };
}

/**
 * The rail refetches whenever the SERVER re-rendered the shell.
 *
 * ⚠️ THIS EXISTS BECAUSE MOVING THE RAIL INTO THE CACHE BREAKS THE ONLY THING
 * THAT USED TO KEEP IT FRESH, AND IT IS NOT OPTIONAL UNTIL PHASE 2 LANDS.
 *
 * Every mutation in this app ends in a `revalidatePath` and a `router.refresh()`
 * (`actions.ts`, and a second one at most control call sites). That re-runs the
 * layout, which is how the counts in the rail used to move. It does NOT remount
 * a client component, so a `useQuery` sitting inside one would sit there holding
 * yesterday's numbers: `staleTime` is a permission to refetch, not a trigger,
 * and the shell never unmounts, so nothing would ever ask. Completing a task
 * would leave the count exactly where it was — the same symptom the migration
 * set out to fix, arrived at from the opposite direction.
 *
 * `serverRenderedAt` changes on every server render of the shell, so this is
 * precisely the old refresh signal, forwarded. It is not a poll and it is not a
 * timer: no mutation, no invalidation.
 *
 * ⚠️ THE FIRST VALUE IS SKIPPED. Without the ref, mount would invalidate the
 * query it just started and buy a second round trip on every page load.
 *
 * ⚠️ PHASE 2 WAS SUPPOSED TO DELETE THIS AND DID NOT. NOR DID P12-09, WHICH
 * DELETED EVERY OTHER `router.refresh()` IN THE TASK PATH. The reason has
 * changed, so it is restated here in full rather than left to be re-derived.
 *
 * Two of the three arguments for keeping it are now spent:
 *
 *   1. "NOTHING INVALIDATES `qk.snapshot()` FROM A MUTATION YET" — no longer
 *      true of TASKS. `invalidateTaskWrite` names `qk.snapshot()` and every task
 *      control calls it, so a status change, a delete, a rename and a new task
 *      all move the rail directly. That is the P12-08 split: the rail is fired
 *      rather than awaited, so the counts land a beat after the row does.
 *   2. REALTIME DEGRADES TO OFF FOR THE REST OF THE PAGE VIEW, BY DESIGN, and
 *      `realtimeDepartmentFilter` is narrower than what the rail counts. Both
 *      still true, and both now covered for tasks by (1) — your own write no
 *      longer depends on a round trip through Postgres and back over a socket.
 *
 * ⚠️ WHAT KEEPS IT ALIVE IS THE SIX DOMAINS THAT HAVE NOT BEEN CONVERTED.
 * Lists, requests, approvals, the inbox, the timesheet and DTR all still write
 * through Server Actions that end in `revalidatePath` and touch the query cache
 * NOWHERE. Creating a personal list, approving a request, reading a
 * notification, submitting a week — not one of them invalidates `qk.snapshot()`,
 * and the rail carries a count for every one of them. `revalidatePath` re-runs
 * `sidebar-panel.tsx`, which is what changes `serverRenderedAt`, which is what
 * this turns into the one invalidation that keeps those numbers honest. Delete
 * it today and the rail silently stops counting for two thirds of the product.
 *
 * ⚠️ SO THE CONDITION IS NOW EXPLICIT: it goes when the LAST domain that
 * writes without invalidating is converted (Phases 4–6), not when the plan
 * document says a phase number. The cost of keeping it is one extra invalidation
 * on renders that came from the server anyway — and after P12-09 those are
 * navigations and other domains' writes, not task clicks.
 */
function useRefetchOnServerRender(serverRenderedAt: number) {
  const client = useQueryClient();
  const seen = useRef(serverRenderedAt);

  useEffect(() => {
    if (seen.current === serverRenderedAt) return;
    seen.current = serverRenderedAt;
    void client.invalidateQueries({ queryKey: qk.snapshot() });
  }, [client, serverRenderedAt]);
}

export function SidebarFromSnapshot({
  sections,
  canManageLists,
  user,
  serverRenderedAt,
}: {
  sections: SidebarSection[];
  canManageLists: boolean;
  user: { fullName: string; email: string; role: string; departments: string[] };
  /** When the server last rendered the shell. See `useRefetchOnServerRender`. */
  serverRenderedAt: number;
}) {
  useRefetchOnServerRender(serverRenderedAt);

  const query = useQuery({
    queryKey: qk.snapshot(),
    /*
     * ⚠️ THE CLIENT IS BUILT INSIDE THE `queryFn`, NOT IN THE COMPONENT BODY. A
     * `"use client"` component is still rendered on the server for its initial
     * HTML, and `createBrowserClient` reaches for `document.cookie` — which is
     * why `browserClient()` is lazy, and why calling it up here would move that
     * reach into the server pass. A `queryFn` only ever runs in the browser.
     */
    queryFn: () => fetchSidebarSnapshot(browserClient()),
  });

  /*
   * THE SKELETON IS THE PENDING STATE, AND IT IS THE ONE THAT WAS ALREADY THERE.
   * `AppSidebarSkeleton` draws the rail's FRAME at its real width, so nothing in
   * the content area moves when the real one arrives — the whole argument is in
   * that file. It used to be a Suspense fallback in the layout; the boundary
   * stays where it is for the server component above, and this is the same
   * fallback for the same wait, one layer in.
   *
   * `isPending` is "no data yet", not "fetching": a background refetch over data
   * we already have must NOT throw the rail away and redraw a skeleton, which is
   * the flicker the whole cache exists to remove.
   */
  if (query.isPending) return <AppSidebarSkeleton />;

  const snapshot: SidebarSnapshot | undefined = query.data;

  /*
   * ⚠️ A FAILED READ WITH NOTHING CACHED IS NOT AN EMPTY DEPARTMENT.
   *
   * This is the distinction Phase 1 exists for. `spaces: []` renders as "Create
   * a list" over nothing — a person holding twenty-two lists, told they have
   * none, with no error anywhere on screen. `NavProjects` takes `unavailable`
   * and says so instead; every other prop it has is untouched.
   */
  const unavailable = snapshot === undefined;

  // Data we have, over a refetch that has since failed. The tree is still true;
  // the counts are not vouched for. See `withUnknownCounts`.
  const countsAreStale = query.isError && snapshot !== undefined;

  const spaces = (snapshot?.spaces ?? []).map((space) =>
    countsAreStale ? withUnknownCounts(space) : space,
  );

  return (
    <AppSidebar
      sections={sections}
      badges={{
        /*
         * ⚠️ NOT `?? 0`. `formatNavBadge` hides a zero, so an unknown count
         * folded into one would render as a missing badge — and "no unread
         * notifications" is precisely what a person would read that as. There is
         * no honest badge for "we could not find out", so the badge is absent
         * and the tree below carries the failure where there is room to say it.
         */
        "/inbox": snapshot ? labelledBadge(formatNavBadge(snapshot.unread), "unread") : null,
        "/requests": snapshot
          ? labelledBadge(formatNavBadge(snapshot.awaiting_review), "awaiting review")
          : null,
      }}
      spaces={spaces}
      unavailable={unavailable}
      canManageLists={canManageLists}
      personalLists={snapshot?.personal ?? []}
      user={user}
    />
  );
}

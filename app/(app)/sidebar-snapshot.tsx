"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AppSidebar, type SidebarSection } from "@/components/app-shell/app-sidebar";
import { AppSidebarSkeleton } from "@/components/app-shell/app-sidebar-skeleton";
import type { ProjectSpace } from "@/components/app-shell/nav-projects";
import { formatNavBadge } from "@/lib/navigation";
import { browserClient } from "@/lib/query/browser-client";
import { fetchSidebarSnapshot } from "@/lib/query/fetchers/snapshot";
import { qk } from "@/lib/query/keys";
import type { SidebarSnapshot } from "@/lib/schemas/sidebar";

/**
 * P12-01 — the rail, read from the query cache.
 *
 * ⚠️ SEEDED BY THE SERVER, NOT FETCHED ON MOUNT. Staging's version started empty
 * and fetched from the browser, which put a skeleton on every cold load. Here
 * `sidebar-panel.tsx` runs the same RPC during the server render and hands the
 * result in as `initialSnapshot`, so the first paint is exactly what it was.
 * What the cache adds is that the rail can refresh ITSELF — a realtime ping
 * invalidates `qk.snapshot()` and this refetches one RPC, instead of
 * `router.refresh()` re-rendering the whole route to move one badge.
 *
 * ⚠️ NO AUTHORIZATION IS DECIDED HERE. Which departments may be reordered and
 * which one is the collaboration space are `AuthContext` output, computed on the
 * server and passed in as id lists. The snapshot itself is `SECURITY INVOKER`,
 * so a browser refetch sees exactly what the policies allow.
 */

function labelledBadge(
  value: string | null,
  description: string,
): { value: string; description: string } | null {
  return value === null ? null : { value, description };
}

/**
 * Server renders still happen — every mutation ends in `revalidatePath` or
 * `router.refresh()`, and those re-run `sidebar-panel.tsx`. A re-render does not
 * remount this component, so `initialData` would be ignored and the rail would
 * keep its old counts. Each fresh server snapshot is written into the cache
 * instead; a server render whose snapshot failed invalidates, so the browser
 * tries for itself.
 *
 * The first value is skipped — it is already the query's `initialData`.
 */
function useAdoptServerSnapshot(snapshot: SidebarSnapshot | null, renderedAt: number) {
  const client = useQueryClient();
  const seen = useRef(renderedAt);

  useEffect(() => {
    if (seen.current === renderedAt) return;
    seen.current = renderedAt;
    if (snapshot) {
      client.setQueryData(qk.snapshot(), snapshot, { updatedAt: renderedAt });
    } else {
      void client.invalidateQueries({ queryKey: qk.snapshot() });
    }
  }, [client, snapshot, renderedAt]);
}

export function SidebarFromSnapshot({
  sections,
  canManageLists,
  user,
  initialSnapshot,
  serverRenderedAt,
  reorderableDepartmentIds,
  sharedDepartmentIds,
}: {
  sections: SidebarSection[];
  canManageLists: boolean;
  user: { fullName: string; email: string; role: string; departments: string[] };
  /** The server's read of the same RPC, or null if it failed. */
  initialSnapshot: SidebarSnapshot | null;
  serverRenderedAt: number;
  /** P7-74 — departments whose folders and lists this person may drag. */
  reorderableDepartmentIds: string[];
  /** P13-01 — the collaboration space, kept in the rail while empty. */
  sharedDepartmentIds: string[];
}) {
  useAdoptServerSnapshot(initialSnapshot, serverRenderedAt);

  const query = useQuery({
    queryKey: qk.snapshot(),
    // The client is built inside the `queryFn`: it only ever runs in the
    // browser, and `createBrowserClient` needs `document.cookie`.
    queryFn: () => fetchSidebarSnapshot(browserClient()),
    initialData: initialSnapshot ?? undefined,
    initialDataUpdatedAt: serverRenderedAt,
  });

  // No data at all — the server read failed and the browser's is in flight.
  if (query.isPending) return <AppSidebarSkeleton />;

  const snapshot = query.data;

  const spaces: ProjectSpace[] = (snapshot?.spaces ?? [])
    .map((space) => ({
      ...space,
      canReorder: reorderableDepartmentIds.includes(space.departmentId),
    }))
    // A department with nothing in it opens onto nothing — except the
    // collaboration space, which has nobody whose job it is to set it up.
    .filter(
      (space) =>
        space.lists.length > 0 ||
        space.folders.length > 0 ||
        sharedDepartmentIds.includes(space.departmentId),
    );

  return (
    <AppSidebar
      sections={sections}
      badges={{
        "/inbox": snapshot ? labelledBadge(formatNavBadge(snapshot.unread), "unread") : null,
        "/requests": snapshot
          ? labelledBadge(formatNavBadge(snapshot.awaiting_review), "awaiting review")
          : null,
      }}
      spaces={spaces}
      canManageLists={canManageLists}
      personalLists={snapshot?.personal ?? []}
      user={user}
    />
  );
}

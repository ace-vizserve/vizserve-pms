import { PageShell } from "@/components/page-shell";

import { TaskDetailSkeleton } from "./detail-skeleton";

/**
 * P12-06 — the shape moved to `detail-skeleton.tsx`, which has two callers now.
 *
 * This boundary still draws it while Next resolves the segment; the client tree
 * draws the same thing while `qk.task(id)` is `isPending`. One definition, so
 * the router's placeholder and the page's own hand over to each other without
 * the layout jumping — see that file's header, and `grid.ts` above it.
 */
export default function Loading() {
  return (
    // Mirrors the loaded page. A skeleton laid out differently from what
    // replaces it is worse than none — the content visibly jumps into a
    // different shape the moment it arrives.
    <PageShell className="gap-3">
      <TaskDetailSkeleton />
    </PageShell>
  );
}

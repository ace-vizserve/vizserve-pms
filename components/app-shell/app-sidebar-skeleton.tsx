import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * P11-05 — what the rail looks like while its eight queries are in flight.
 *
 * ⚠️ IT MIRRORS THE REAL SIDEBAR'S FRAME, NOT ITS CONTENTS, and the split is the
 * point. `components/skeletons.tsx` opens by warning that a skeleton which stops
 * matching what replaces it is worse than none, because the page visibly
 * rearranges the moment data lands. The frame here — the 19rem panel, the raised
 * brand card at the top, the raised user card at the foot — is fixed and is
 * drawn exactly. What sits between them is NOT: the nav is role-dependent and
 * the project tree is a department's whole list of lists, so its height is
 * unknowable and pretending otherwise would guarantee the rearrangement.
 *
 * So the middle is a plausible run of rows in two groups, which is what every
 * role has some version of. The rail's WIDTH is what actually stops the layout
 * moving, and that comes from `<Sidebar>` itself rather than from anything here.
 *
 * `aria-hidden`, matching every other loading state in this repo: the page is
 * announced by the router, and a second announcement from furniture interrupts
 * it.
 */
export function AppSidebarSkeleton() {
  return (
    <Sidebar variant="sidebar" aria-hidden>
      <SidebarHeader>
        {/* The brand lockup. Same 52px raised card the real one carries, so the
            content below it starts at the same y. */}
        <Skeleton className="h-13 w-full rounded-md" />
      </SidebarHeader>

      <SidebarContent className="gap-4 px-2 py-2">
        {[5, 3].map((rows, group) => (
          <div key={group} className="space-y-1">
            <Skeleton className="mb-2 h-3 w-20" />
            {Array.from({ length: rows }, (_, row) => (
              <Skeleton key={row} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <Skeleton className="h-13 w-full rounded-md" />
      </SidebarFooter>
    </Sidebar>
  );
}

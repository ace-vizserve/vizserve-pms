import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Its own skeleton, rather than inheriting the group's — see the note in
 * `app/(app)/forms/new/loading.tsx`. The home's bento is not a stand-in for a
 * table of lists.
 */
export default function Loading() {
  return (
    <PageShell>
      <div className="flex items-center justify-between gap-4" aria-hidden>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>
      <TableSkeleton columns={4} rows={6} />
    </PageShell>
  );
}

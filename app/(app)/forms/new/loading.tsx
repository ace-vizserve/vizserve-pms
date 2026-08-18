import { PageShell } from "@/components/page-shell";
import { CardSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Its own skeleton, rather than inheriting the group's.
 *
 * `app/(app)/loading.tsx` is the home's bento placeholder, and a `loading.tsx`
 * covers its segment AND every descendant without one — so without this file,
 * opening the new-form page flashed six dashboard cells before showing a form.
 */
export default function Loading() {
  return (
    <PageShell className="max-w-2xl">
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-72" />
      </div>
      <CardSkeleton lines={6} />
    </PageShell>
  );
}

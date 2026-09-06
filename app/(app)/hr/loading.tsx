import { PageShell } from "@/components/page-shell";
import { TableSkeleton } from "@/components/skeletons";

/**
 * One file covering all four HR screens, none of which had a loading state.
 *
 *   /hr/attendance    the heaviest of the four by a wide margin — a whole
 *                     month of DTR rows for every active user, plus leave,
 *                     holidays and overtime
 *   /hr/balances      every user crossed with every leave type
 *   /hr/reports       three reads
 *   /hr/leave-types   one
 *
 * ⚠️ IT LIVES AT THE SEGMENT, NOT BESIDE EACH PAGE, because Next inherits
 * `loading.tsx` down the tree and all four of these render the same thing: a
 * `PageShell` with one wide table in it. Four copies would be four things to
 * keep in step with a shared shape, which is the drift
 * `components/skeletons.tsx` was extracted to stop.
 *
 * Six columns because attendance and balances are both wide; the two lighter
 * screens over-draw by a column or two, which is a far smaller error than the
 * blank screen this replaces. Any one of the four that grows a genuinely
 * different shape should take its own `loading.tsx` beside its `page.tsx` and
 * override this — a fallback that stops matching what replaces it is worse than
 * none, per the header of `skeletons.tsx`.
 */
export default function Loading() {
  return (
    <PageShell>
      <TableSkeleton columns={6} rows={8} />
    </PageShell>
  );
}

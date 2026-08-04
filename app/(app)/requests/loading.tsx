import { PageShell } from "@/components/page-shell";
import { FilterBarSkeleton, TableSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <PageShell>
      <FilterBarSkeleton fields={4} />
      <TableSkeleton columns={5} />
    </PageShell>
  );
}

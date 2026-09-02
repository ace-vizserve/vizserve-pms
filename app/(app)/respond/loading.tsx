import { PageShell } from "@/components/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The card grid, before it arrives. Same shape as the real list so the page
 * does not reflow when the forms land.
 */
export default function Loading() {
  return (
    <PageShell>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
        {Array.from({ length: 6 }).map((_, index) => (
          <li key={index}>
            <Skeleton className="h-24 w-full" />
          </li>
        ))}
      </ul>
    </PageShell>
  );
}

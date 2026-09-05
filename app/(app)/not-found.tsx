import Link from "next/link";
import { Compass } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";

/**
 * The 404 INSIDE the app, which is a different page from the one at the root.
 *
 * Next resolves `notFound()` to the nearest `not-found.tsx` up the tree, so
 * every `notFound()` under `(app)` that has no scoped page of its own landed on
 * the root one — outside `app/(app)/layout.tsx`, and therefore with no sidebar,
 * no breadcrumb and no way back except a link. Losing the entire shell because
 * one task id was stale is a bigger event than what actually happened.
 *
 * This renders INSIDE the shell. The nav stays, the breadcrumb stays, and the
 * missing thing is missing in the middle of the page where it belongs.
 *
 * ⚠️ IT MUST NOT SAY WHETHER THE ROW EXISTS. Three of the four callers —
 * `tasks/[id]`, `requests/[id]`, `respond/[slug]` — reach `notFound()` when RLS
 * returns zero rows, which is a scope answer and not an existence one. "No such
 * task" and "not your task" have to look identical from here, because the
 * difference is itself information about somebody else's work. The copy says
 * what the reader can act on and stops.
 *
 * `approvals/[id]` keeps its own `not-found.tsx` and should: it can name the
 * exact rule that scoped the reader out, which is worth far more than this
 * general wording. That is the model for any route where the rule is nameable —
 * this page is the floor, not the ceiling.
 */
export default function NotFound() {
  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      <EmptyState
        icon={<Compass />}
        title="We could not find that"
        description="The link may be out of date, or the item may have been deleted. It may also belong to a department you do not have access to — this page looks the same either way."
        action={
          /* A link, not a Button with a render slot: it navigates. */
          <Link href="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Back to the dashboard
          </Link>
        }
      />
    </PageShell>
  );
}

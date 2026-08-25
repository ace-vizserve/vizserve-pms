import Link from "next/link";
import { ArrowLeft, EyeOff } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";

/**
 * What a 404 on this route actually means.
 *
 * The bare not-found page was costing real time. A request outside your scope
 * returns zero rows through RLS — by design, and `notFound()` is the right
 * response — but the page said nothing, so the same blank 404 was read as a
 * broken route, a missing migration, or a bug in the query. Diagnosing one
 * instance took a service-role sweep of every account to establish that the
 * database was behaving exactly as intended.
 *
 * So the page says which of the two it is, and names the rule. It still does
 * NOT say whether the request exists — that would defeat the scoping, since
 * "exists but not for you" is itself information about somebody's leave.
 *
 * The rule below is the policy on `vizserve_pms_internal_requests`, in words:
 *
 *   requester_id = auth.uid() or vizserve_pms_manages_department(department_id)
 *
 * and `manages_department` is true for an admin, for a manager over their
 * departments, and for a team leader over the ones they actually lead — holding
 * the role is not enough, the department has to be in their managed set (D15).
 */
export default function NotFound() {
  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      <div className="flex flex-col items-center gap-3 rounded-lg border bg-card grade-surface px-4 py-12 text-center shadow-raised-lg">
        <EyeOff className="size-5 text-muted-foreground" aria-hidden />

        <p className="text-base font-semibold tracking-[-0.014em]">
          This request is not yours to see
        </p>

        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          Internal requests are visible to the person who filed them and to the leads of that
          person&rsquo;s department — nobody else, including colleagues on other teams. If you were
          expecting to decide this one, check that the department it belongs to is ticked against
          your account under Admin &rarr; Users.
        </p>

        <p className="max-w-md text-2xs leading-relaxed text-muted-foreground">
          Holding Team Leader is not enough on its own: scope comes from the departments you lead,
          not from the role. This page looks the same whether or not the request exists, which is
          deliberate.
        </p>

        <Link
          href="/approvals"
          className={buttonVariants({ variant: "outline", size: "sm", className: "mt-2" })}
        >
          <ArrowLeft />
          Back to approvals
        </Link>
      </div>
    </PageShell>
  );
}

import type { Metadata } from "next";

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { ApprovalsViewer } from "@/lib/schemas/internal-approvals";

import { ApprovalsView, type ApprovalsSearchParams } from "./approvals-view";

export const metadata: Metadata = { title: "Approvals" };

/**
 * P5-10 / P12-19 — the approvals page: the SERVER half, which is auth and the
 * viewer and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — eight queries in one wave, then a
 * ninth keyed by the reviewers it had just fetched, plus the sort allowlist, the
 * paging arithmetic, the P7-45 gender filter and the `waitingOnMe` narrowing.
 * P12-19 moved the reads into the TanStack cache (`approvals-view.tsx`,
 * `lib/query/fetchers/approvals.ts`) and left behind exactly two things that
 * must not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase.
 *   2. THE VIEWER. Every field on it is a role, department or eligibility
 *      decision, and `lib/auth/authorization.ts` is `server-only` — so each has
 *      to be resolved here and travel as a flag. `waitingOnMe` then runs in the
 *      fetcher against exactly the three fields it has always taken.
 *
 * ⚠️ AND EVERY FIELD ON THAT VIEWER IS PRESENTATION. It decides which button a
 * person sees on four screens; `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` decide whether it works. A mistake
 * here shows the wrong control, never the wrong permission — which is the
 * property that makes passing any of it to the browser safe at all.
 *
 * ⚠️ IT ISSUES NO QUERY NOW. Opening this page cost nine server reads before
 * anything painted; it costs the session lookup `requireAuthContext()` already
 * does for the layout and nothing else.
 * ------------------------------------------------------------------------
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<ApprovalsSearchParams>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

  const viewer: ApprovalsViewer = {
    userId: context.userId,
    role: context.role,
    /*
     * ⚠️ WHICH DEPARTMENTS THIS PERSON LEADS, NOT WHICH ROLE THEY HOLD. D15: the
     * role alone is not enough, which is the whole point of the managed-set
     * table — and `waitingOnMe` reads both.
     */
    managedDepartmentIds: context.managedDepartmentIds,
    /* P7-45. Maternity, Special Leave for Women and VAWC are FEMALE; Paternity
       is MALE; everything else applies to everyone, and a gender that was never
       recorded sees the whole list. `leaveTypeApplies` and the database trigger
       agree on that, and they have to: a picker offering something the insert
       then refuses is worse than either rule on its own. */
    gender: context.gender,
    /*
     * P8 — THE GATE ON TWO OF THE THREE QUEUES, resolved once.
     *
     * ⚠️ NOT ON THE THIRD. The reliever queue is read for EVERYBODY, because a
     * reliever is usually a plain `member` — the gate that returns nothing for a
     * member is exactly what would hide the one decision they are owed. That
     * split lives in `lib/approvals-queue.ts`; this flag is what it switches on.
     */
    isApprover: roleAtLeast(context.role, "team_leader"),
    /* P8-01: `roleAtLeast`, not `=== "admin"` — the top rung is now `owner`, and
       the equality would be true for nobody. */
    isAdmin: roleAtLeast(context.role, "owner"),
    /* The same row the submit function will consult, so the form cannot
       disagree with the rule that refuses it. */
    hasDepartment: Boolean(context.primaryDepartmentId),
    fullName: context.fullName,
  };

  return <ApprovalsView params={params} viewer={viewer} />;
}

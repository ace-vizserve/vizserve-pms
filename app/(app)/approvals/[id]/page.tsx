import type { Metadata } from "next";

import { requireAuthContext } from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { ApprovalsViewer } from "@/lib/schemas/internal-approvals";

import { ApprovalDetailView } from "./approval-detail";

export const metadata: Metadata = { title: "Request" };

/**
 * P5-10 / P12-19 — one internal request: the SERVER half, which is auth and the
 * viewer and nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — a row with two embeds, a wave of
 * three more, the stage-rail derivation and both withdrawal routes. P12-19 moved
 * the reads into the TanStack cache (`approval-detail.tsx`,
 * `lib/query/fetchers/approvals.ts`) and every derivation with them, unchanged,
 * leaving exactly two things that must not move:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check. Authentication does not go through the
 *      cache, in any phase.
 *   2. THE VIEWER, for the same reason `/approvals` needs one:
 *      `lib/auth/authorization.ts` is `server-only`, so `waitingOnMe` gets the
 *      three fields it has always taken as a prop. It is the SAME viewer shape
 *      the queue uses, which is what stops the list that sent somebody here and
 *      the panel they find from disagreeing.
 *
 * ⚠️ THE 404 MOVED WITH THE ROW AND THE ORDER IS THE POINT. `notFound()` is now
 * called in the client component after `isPending` and `isError` are ruled out.
 * The RSC lost an afternoon to not having that order: a row outside your scope
 * returns nothing under RLS and IS a 404, but a FAILED query is a fault, and
 * rendering the same bare not-found page for both sent whoever was debugging to
 * look at RLS.
 *
 * ⚠️ AND `not-found.tsx` BESIDE THIS FILE STILL APPLIES — it is scoped to this
 * route segment, so it catches the sentinel whichever side of the wire throws it.
 * ------------------------------------------------------------------------
 */
export default async function InternalRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requireAuthContext();

  const viewer: ApprovalsViewer = {
    userId: context.userId,
    role: context.role,
    /* D15 — which departments this person LEADS. The role alone is not enough,
       and `waitingOnMe` reads both. */
    managedDepartmentIds: context.managedDepartmentIds,
    gender: context.gender,
    /* Not read on this page, and carried anyway so the shape is the SAME
       `ApprovalsViewer` the queue builds. Two viewer types for two views of one
       module is two things to keep in step for no gain. */
    isApprover: roleAtLeast(context.role, "team_leader"),
    isAdmin: roleAtLeast(context.role, "owner"),
    hasDepartment: Boolean(context.primaryDepartmentId),
    fullName: context.fullName,
  };

  return <ApprovalDetailView requestId={id} viewer={viewer} />;
}

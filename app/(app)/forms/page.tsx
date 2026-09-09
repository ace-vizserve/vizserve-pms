import type { Metadata } from "next";

import { requireDepartmentShape } from "@/lib/auth/authorization";

import { FormsView } from "./forms-view";

export const metadata: Metadata = { title: "Forms" };

/**
 * P1-05 — forms list.
 *
 * ------------------------------------------------------------------------
 * ⚠️ P12-22 — THE THREE READS AND EVERY DERIVATION LEFT THIS FILE. WHAT IS
 * STILL HERE IS THE GATE AND THE SEAT, AND NEITHER MAY LEAVE.
 *
 * 1. THE GATE. `requireDepartmentShape()` — P8-01c; it was `requireRole(
 *    "team_leader")` until a department admin, who may be a MEMBER by rank,
 *    needed to build their own department's client forms. It refuses somebody
 *    who shapes no department at all; WHICH forms are theirs is
 *    `administersForm`, applied per row beside the rows. Settled decision 6 —
 *    authentication does not move in any phase of the SPA migration.
 *
 * 2. THE SEAT. `viewer` is the five fields of that context the two per-row rules
 *    read, resolved here and handed down. Nothing in `forms-view.tsx` asks the
 *    browser who it is, and `FormAdminScope` is deliberately narrower than
 *    `AuthContext` — no session, no email, no HR flag reaches the bundle.
 *
 * The reads, the administrative filter and the readable-submissions rule are
 * `forms-view.tsx` and `lib/query/fetchers/forms.ts`.
 *
 * No <h1>. The shell breadcrumb is the page label.
 * ------------------------------------------------------------------------
 */
export default async function FormsPage() {
  const context = await requireDepartmentShape();

  return (
    <FormsView
      viewer={{
        userId: context.userId,
        role: context.role,
        managedDepartmentIds: context.managedDepartmentIds,
        isDeptAdmin: context.isDeptAdmin,
        primaryDepartmentId: context.primaryDepartmentId,
      }}
    />
  );
}

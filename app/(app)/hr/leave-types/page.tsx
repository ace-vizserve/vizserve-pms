import type { Metadata } from "next";

import { requireHr } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { LeaveTypesTable, type LeaveTypeRow } from "./leave-types-table";

export const metadata: Metadata = { title: "Leave types" };

/**
 * P7-52 — the screen `vizserve_pms_leave_types` never had.
 *
 * P7-12 created the table with an admin-write policy and no way to reach it.
 * Since then P7-42 added `calendar_visibility` and P7-45 added
 * `applies_to_gender`, both set by a one-off `update` in their own migration —
 * so five columns of live policy data have only ever been editable by pasting
 * SQL into the Supabase console. D25 called types "policy data HR will change";
 * this is the first time they can.
 *
 * Read through the ORDINARY RLS client. The policy is "readable by any active
 * user, writable by HR", so this is the same query a member's leave picker
 * runs — which is worth keeping true. The service role appears only in the
 * write actions, where the audit row needs it.
 *
 * NOT PAGINATED and not year-scoped, unlike holidays beside it. This list is
 * bounded by statute and taste at around a dozen rows, and it will still be a
 * dozen in five years.
 */
export default async function LeaveTypesPage() {
  await requireHr();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_leave_types")
    .select("id, code, label, is_active, sort_order, applies_to_gender, calendar_visibility")
    .order("sort_order")
    .order("label");

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "HR / Leave types". This paragraph says
          what the screen cannot: that these rows are load-bearing in three
          separate places, and that retiring is not deleting. */}
      <p className="text-xs text-muted-foreground">
        The kinds of leave people can file. Retiring a type removes it from the picker and keeps
        every request already filed under it, which is why nothing here deletes. Visibility decides
        what colleagues see on the shared calendar — two types are statutory confidences and are
        withheld entirely.
      </p>

      {error ? (
        <QueryError what="leave types" message={error.message} />
      ) : (
        <LeaveTypesTable types={(data ?? []) as LeaveTypeRow[]} />
      )}
    </PageShell>
  );
}

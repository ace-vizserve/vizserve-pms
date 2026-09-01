import type { Metadata } from "next";

import { requireHr } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { currentBalanceYear } from "@/lib/schemas/leave-balances";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { ReportBuilder } from "./report-builder";

export const metadata: Metadata = { title: "Leave reports" };

/**
 * P7-53 — the leave audit, with its filters exposed.
 *
 * The report has existed since P7-34 as a single button on `/admin/users` that
 * printed EVERYBODY, WHOLE-YEAR, ALL TYPES, always — one argument, `p_year`.
 * This is the same document with the four filters HR asked for, plus a second
 * mode for an arbitrary period.
 *
 * ⚠️ THE PICKERS ARE NOT THE AUTHORITY. Everything offered below is read
 * through the ordinary RLS client, so a lead opening this screen sees only the
 * people they lead in the staff picker — but that is a convenience, not a
 * control. Both RPCs re-check scope themselves, because they are SECURITY
 * DEFINER and bypass every policy that produced these lists. Picking somebody
 * you may not see returns no rows rather than their record.
 */
export default async function LeaveReportsPage() {
  await requireHr();
  const supabase = await createClient();

  const [{ data: people, error: peopleError }, { data: departments }, { data: types }] =
    await Promise.all([
      supabase
        .from("vizserve_pms_users")
        .select("id, full_name, is_active")
        .order("is_active", { ascending: false })
        .order("full_name"),
      supabase.from("vizserve_pms_departments").select("id, name").order("name"),
      // Retired types included, deliberately: filtering TO a retired type is
      // exactly the case this report exists for — an auditor checking what was
      // taken under a type that was withdrawn mid-year.
      supabase
        .from("vizserve_pms_leave_types")
        .select("id, label, is_active")
        .order("sort_order")
        .order("label"),
    ]);

  const currentYear = currentBalanceYear(todayInAppZone());

  return (
    <PageShell>
      <p className="text-xs text-muted-foreground">
        Two documents. The annual audit is the one run in December to settle unused days — it shows
        what each person was allocated, used and has left. Leave taken covers any period you choose
        and lists the actual absences; it shows no allocation, because allocation is annual and a
        figure for part of a year would not be true of anything. Every PDF prints the filters it
        applied.
      </p>

      {peopleError ? (
        <QueryError what="the report options" message={peopleError.message} />
      ) : (
        <ReportBuilder
          currentYear={currentYear}
          today={todayInAppZone()}
          people={people ?? []}
          departments={departments ?? []}
          leaveTypes={types ?? []}
        />
      )}
    </PageShell>
  );
}

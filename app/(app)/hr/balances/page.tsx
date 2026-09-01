import type { Metadata } from "next";

import { requireHr } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { balanceYearSchema, currentBalanceYear } from "@/lib/schemas/leave-balances";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { BalancesGrid, type BalancePerson, type BalanceLeaveType } from "./balances-grid";

export const metadata: Metadata = { title: "Leave balances" };

/**
 * P7-52 — leave allocations for everybody, on one screen.
 *
 * Until now the only way to set an allocation was the dialog on `/admin/users`,
 * one person at a time, behind two clicks. That is the right shape for changing
 * one person's entitlement and the wrong one for the job this actually is: at
 * the start of a year HR sets the whole company's allocations in one sitting.
 *
 * ⚠️ THIS IS THE READ p7_33:220-222 PREDICTED. That comment declined to add an
 * index because "reading a whole year across everybody is an admin report that
 * does not exist yet; when it does, it wants (balance_year, user_id)". P7-52
 * adds exactly that index, for exactly this query.
 *
 * ONE YEAR AT A TIME, from the URL so the view is linkable, and because an
 * allocation is per year by definition — there is no "all years" reading of
 * this screen that means anything.
 *
 * Read through the ORDINARY RLS client. The read policy on
 * `vizserve_pms_leave_balances` is "yours, your lead's, or HR's", so this
 * returns the whole company for the person on this screen and would return far
 * less for anybody else — which is the property worth keeping true. The service
 * role appears only in the write action, where the audit row needs it.
 *
 * ⚠️ USAGE IS DELIBERATELY NOT SHOWN HERE. This grid edits ALLOCATION, which is
 * one number per person per type per year. Used and remaining are computed per
 * person by `vizserve_pms_leave_balance_summary` (D27) and showing them would
 * mean one RPC per row — thirty round trips to decorate a form. The audit
 * report at /hr/reports is where those figures belong.
 */
export default async function LeaveBalancesPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  await requireHr();
  const supabase = await createClient();

  const params = await searchParams;
  const requested = Array.isArray(params.year) ? params.year[0] : params.year;

  // Manila's year. In the first eight hours of 1 January a UTC server is still
  // in December, and this is a screen used in the first week of January.
  const currentYear = currentBalanceYear(todayInAppZone());

  // Narrowed rather than trusted, and falling back rather than throwing: a
  // mangled `?year=banana` opens the current year, not an error page.
  const parsedYear = balanceYearSchema.safeParse(requested ?? currentYear);
  const year = parsedYear.success ? (parsedYear.data as number) : currentYear;

  const [
    { data: people, error: peopleError },
    { data: types, error: typesError },
    { data: rows, error: rowsError },
  ] = await Promise.all([
    supabase
      .from("vizserve_pms_users")
      .select("id, full_name, email, gender, is_active, primary_department_id")
      // Deactivated accounts sink to the bottom rather than vanishing: a
      // leaver can still hold an allocation for the year they left, and the
      // audit report will show it.
      .order("is_active", { ascending: false })
      .order("full_name"),
    supabase
      .from("vizserve_pms_leave_types")
      .select("id, label, is_active, sort_order, applies_to_gender")
      .order("sort_order")
      .order("label"),
    supabase
      .from("vizserve_pms_leave_balances")
      .select("user_id, leave_type_id, days_allocated")
      .eq("balance_year", year),
  ]);

  const { data: departments } = await supabase
    .from("vizserve_pms_departments")
    .select("id, name")
    .order("name");

  const error = peopleError ?? typesError ?? rowsError;

  // Keyed `userId:typeId`, built once here rather than searched per cell — the
  // grid is people x types and a linear scan per cell is O(n^2) on the one
  // screen that renders every person in the company.
  const allocations: Record<string, number> = {};
  for (const row of rows ?? []) {
    allocations[`${row.user_id}:${row.leave_type_id}`] = row.days_allocated;
  }

  return (
    <PageShell>
      {/* Four lines of 12px grey trimmed to the two facts somebody typing in
          this grid can act on. Days TAKEN are computed from approved requests
          on every read, so they were never this screen's business and saying so
          at length only pushed the grid further down the page. */}
      <p className="text-xs text-muted-foreground">
        What each person is entitled to this year, per kind of leave. An allocation of zero is a
        decision; a blank box is not, and saves nothing.
      </p>

      {error ? (
        <QueryError what="leave balances" message={error.message} />
      ) : (
        <BalancesGrid
          year={year}
          currentYear={currentYear}
          people={(people ?? []) as BalancePerson[]}
          leaveTypes={(types ?? []) as BalanceLeaveType[]}
          departments={departments ?? []}
          allocations={allocations}
        />
      )}
    </PageShell>
  );
}

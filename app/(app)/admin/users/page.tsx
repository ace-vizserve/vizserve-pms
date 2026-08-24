import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { currentBalanceYear } from "@/lib/schemas/leave-balances";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";

import { UsersTable } from "./users-table";
import type { EditableUser } from "./user-editor";

export const metadata: Metadata = { title: "Users" };

/**
 * P0-04 — user management.
 *
 * This route was in the nav from day one and 404ed until now, which is worse
 * than absent: an admin clicking "Users" and getting a not-found page concludes
 * the app is broken rather than unfinished.
 *
 * Read through the ordinary RLS-scoped client, not the service role. An admin's
 * reach comes from `vizserve_pms_is_admin()` in the policy, so the same query a
 * TL would run returns their department instead — and that is worth keeping
 * true. The service role appears only in the write actions, where provisioning
 * an auth identity genuinely requires it.
 */
export default async function UsersPage() {
  const context = await requireRole("admin");
  const supabase = await createClient();

  // P7-33. Manila's year, not the server's — see `currentBalanceYear`. On
  // 1 January a UTC server is still in December for eight hours, and the editor
  // would open on last year's allocations.
  const balanceYear = currentBalanceYear(todayInAppZone());

  const [{ data: users }, { data: departments }, { data: managed }, { data: leaveTypes }, { data: allocations }] =
    await Promise.all([
      supabase
        .from("vizserve_pms_users")
        .select(
          "id, email, full_name, gender, role, primary_department_id, is_active, app_access, work_start, work_end",
        )
        // Deactivated accounts sink to the bottom; the rest read alphabetically.
        .order("is_active", { ascending: false })
        .order("full_name"),
      supabase.from("vizserve_pms_departments").select("id, name").order("name"),
      supabase.from("vizserve_pms_user_managed_departments").select("user_id, department_id"),

      // Active types only, in the list's own order — the same rule the filing
      // dialog follows. A retired type must not be allocatable for next year,
      // though an allocation already made against one keeps its row.
      supabase
        .from("vizserve_pms_leave_types")
        .select("id, label")
        .eq("is_active", true)
        .order("sort_order"),

      // ALLOCATIONS ONLY, not the used/remaining summary. That summary is one
      // RPC per person and this page is the whole staff list; it is fetched by
      // the editor when a dialog actually opens. What lands here is the number
      // an admin types, which the dialog needs seeded before it can render.
      supabase
        .from("vizserve_pms_leave_balances")
        .select("user_id, leave_type_id, days_allocated")
        .eq("balance_year", balanceYear),
    ]);

  // Grouped in one pass rather than a query per user — this table is the whole
  // staff list and N+1 here is a visible page load.
  const managedByUser = new Map<string, string[]>();
  for (const row of managed ?? []) {
    const list = managedByUser.get(row.user_id) ?? [];
    list.push(row.department_id);
    managedByUser.set(row.user_id, list);
  }

  // Same one-pass grouping, same reason: a query per user to fill a dialog
  // almost none of which is opened would be N+1 on the whole staff list.
  const allocationsByUser = new Map<string, Record<string, number>>();
  for (const row of allocations ?? []) {
    const forUser = allocationsByUser.get(row.user_id) ?? {};
    forUser[row.leave_type_id] = row.days_allocated;
    allocationsByUser.set(row.user_id, forUser);
  }

  const rows: EditableUser[] = (users ?? []).map((user) => ({
    ...user,
    managed_department_ids: managedByUser.get(user.id) ?? [],
    leave_allocations: allocationsByUser.get(user.id) ?? {},
  }));

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Admin / Users". This paragraph stays
          because it is the one thing the screen cannot show: the role ladder is
          inclusive, so the column reading "Manager" is a floor, not a set. */}
      <p className="text-xs text-muted-foreground">
        Roles are inclusive — an admin can do everything a manager can, and so on down. What a
        person can <em>reach</em> is decided by the departments they lead, not by the role alone.
      </p>

      <UsersTable
        users={rows}
        departments={departments ?? []}
        leaveTypes={leaveTypes ?? []}
        balanceYear={balanceYear}
        currentUserId={context.userId}
      />
    </PageShell>
  );
}

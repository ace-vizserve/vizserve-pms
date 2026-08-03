import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";

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

  const [{ data: users }, { data: departments }, { data: managed }] = await Promise.all([
    supabase
      .from("vizserve_pms_users")
      .select("id, email, full_name, role, primary_department_id, is_active")
      // Deactivated accounts sink to the bottom; the rest read alphabetically.
      .order("is_active", { ascending: false })
      .order("full_name"),
    supabase.from("vizserve_pms_departments").select("id, name").order("name"),
    supabase.from("vizserve_pms_user_managed_departments").select("user_id, department_id"),
  ]);

  // Grouped in one pass rather than a query per user — this table is the whole
  // staff list and N+1 here is a visible page load.
  const managedByUser = new Map<string, string[]>();
  for (const row of managed ?? []) {
    const list = managedByUser.get(row.user_id) ?? [];
    list.push(row.department_id);
    managedByUser.set(row.user_id, list);
  }

  const rows: EditableUser[] = (users ?? []).map((user) => ({
    ...user,
    managed_department_ids: managedByUser.get(user.id) ?? [],
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Roles are inclusive — an admin can do everything a manager can, and so on down. What a
          person can <em>reach</em> is decided by the departments they lead, not by the role alone.
        </p>
      </div>

      <UsersTable
        users={rows}
        departments={departments ?? []}
        currentUserId={context.userId}
      />
    </div>
  );
}

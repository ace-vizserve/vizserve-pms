import Link from "next/link";

import { requireAuthContext } from "@/lib/auth/authorization";
import { visibleNavItems } from "@/lib/navigation";
import { createClient } from "@/utils/supabase/server";
import { SidebarNav } from "@/components/app-shell/sidebar-nav";
import { UserMenu } from "@/components/app-shell/user-menu";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await requireAuthContext();
  const items = visibleNavItems(context.role);

  // Names of the departments this person leads — shown in the user menu so the
  // scope that governs every list they see is not invisible.
  let departmentNames: string[] = [];
  if (context.managedDepartmentIds.length > 0) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("vizserve_pms_departments")
      .select("name")
      .in("id", context.managedDepartmentIds)
      .order("name");
    departmentNames = (data ?? []).map((row) => row.name);
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-svh flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-sm bg-primary text-xs font-semibold text-primary-foreground">
              V
            </span>
            <span className="text-sm font-semibold tracking-tight">VizServe PMS</span>
          </Link>

          <div className="ml-auto">
            <UserMenu
              fullName={context.fullName}
              email={context.email}
              role={context.role}
              departments={departmentNames}
            />
          </div>
        </header>

        <div className="flex flex-1">
          <aside className="hidden w-56 shrink-0 border-r bg-sidebar p-3 md:block">
            <SidebarNav items={items} />
          </aside>

          <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

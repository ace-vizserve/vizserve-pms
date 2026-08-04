import { requireAuthContext } from "@/lib/auth/authorization";
import { groupedNavItems } from "@/lib/navigation";
import { createClient } from "@/utils/supabase/server";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import {
  BreadcrumbLabelProvider,
  DynamicBreadcrumb,
} from "@/components/app-shell/dynamic-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await requireAuthContext();
  const sections = groupedNavItems(context.role);

  // The departments this person leads. Shown in the user menu because it is the
  // thing that decides the contents of every list they open, and is otherwise
  // invisible.
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
      <BreadcrumbLabelProvider>
        <SidebarProvider>
          <AppSidebar
            sections={sections}
            user={{
              fullName: context.fullName,
              email: context.email,
              role: context.role,
              departments: departmentNames,
            }}
          />

          <SidebarInset>
            {/*
              h-16 and borderless, matching the template. The header's height is
              what supplies the top gap for every page, which is why PageShell
              carries `pt-0`.
            */}
            <header className="flex h-16 shrink-0 items-center gap-2">
              <div className="flex items-center gap-2 px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
                <DynamicBreadcrumb />
              </div>

              <div className="ml-auto flex items-center gap-2 pr-4">
                <ThemeToggle />
              </div>
            </header>

            <main className="flex flex-1 flex-col">{children}</main>
          </SidebarInset>
        </SidebarProvider>
      </BreadcrumbLabelProvider>
    </TooltipProvider>
  );
}

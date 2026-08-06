import { requireAuthContext } from "@/lib/auth/authorization";
import { groupedNavItems } from "@/lib/navigation";
import { formatUnreadBadge } from "@/lib/notifications";
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

  const supabase = await createClient();

  // The departments this person leads. Shown in the user menu because it is the
  // thing that decides the contents of every list they open, and is otherwise
  // invisible.
  let departmentNames: string[] = [];
  if (context.managedDepartmentIds.length > 0) {
    const { data } = await supabase
      .from("vizserve_pms_departments")
      .select("name")
      .in("id", context.managedDepartmentIds)
      .order("name");
    departmentNames = (data ?? []).map((row) => row.name);
  }

  // The unread badge, deferred at P0-10 (Amier, 21:20) and asked for since.
  //
  // `head: true` — a count with no rows, so this costs one indexable aggregate
  // per navigation rather than shipping notification bodies the shell never
  // renders. RLS scopes it to the caller, so there is no user filter here.
  const { count: unread } = await supabase
    .from("vizserve_pms_notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  return (
    <TooltipProvider>
      <BreadcrumbLabelProvider>
        <SidebarProvider>
          <AppSidebar
            sections={sections}
            badges={{ "/inbox": formatUnreadBadge(unread ?? 0) }}
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

              STICKY: the breadcrumb is how you know where you are, and on a long
              list — the inbox runs to hundreds of rows — it used to scroll away
              and take the sidebar toggle and theme switch with it.

              `bg-background` is doing real work here, not decoration. It is
              fully opaque, so rows pass cleanly underneath; without it they show
              through the header and the text overlaps. That opacity is also why
              this stays borderless as the template intends, instead of needing a
              hairline to separate it from what is sliding under it.
            */}
            <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 bg-background">
              <div className="flex items-center gap-2 px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                />
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

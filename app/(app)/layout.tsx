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
              h-14 and frosted, per the design refresh. The bar is translucent
              (`bg-panel`) with a blur behind it, so rows visibly pass UNDER it
              rather than being hidden by it — which is the point of a sticky
              header on a list that runs to hundreds of rows.

              That translucency is why it now carries a border and a shadow.
              The previous version was opaque and borderless, and relied on the
              opacity alone to separate itself from what slid beneath. A frosted
              bar cannot do that, so `shadow-chrome` supplies the lit top edge
              and the soft cast, and `border-b` the hairline.

              STICKY: the breadcrumb is how you know where you are, and on a
              long list it used to scroll away and take the sidebar toggle and
              theme switch with it.
            */}
            <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-panel shadow-chrome backdrop-blur-md backdrop-saturate-150">
              <div className="flex items-center gap-2 px-4.5">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mr-2 data-vertical:h-4 data-vertical:self-auto"
                />
                <DynamicBreadcrumb />
              </div>

              <div className="ml-auto flex items-center gap-2 pr-4.5">
                <ThemeToggle />
              </div>
            </header>

            {/* The one gradient in the product UI: a broad, very low-contrast wash so
                panels have something to cast onto instead of sitting on a flat slab. */}
            <main className="flex flex-1 flex-col grade-ambient bg-no-repeat">{children}</main>
          </SidebarInset>
        </SidebarProvider>
      </BreadcrumbLabelProvider>
    </TooltipProvider>
  );
}

import { Suspense } from "react";

import { requireAuthContext } from "@/lib/auth/authorization";
import { AppSidebarSkeleton } from "@/components/app-shell/app-sidebar-skeleton";
import {
  BreadcrumbLabelProvider,
  DynamicBreadcrumb,
} from "@/components/app-shell/dynamic-breadcrumb";
import { RealtimeNotifications } from "@/components/realtime-refresh";
import { ShiftReminder } from "@/components/shift-reminder";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

import { SidebarPanel } from "./sidebar-panel";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await requireAuthContext();
  return (
    <TooltipProvider>
      <BreadcrumbLabelProvider>
        {/*
          P8-03 — the unread badge above stops being a number that was only true
          at the moment this layout last rendered.

          IN THE SHELL, NOT ON /inbox, because the badge is in the shell: a
          notification arriving while somebody is on the board has to move the
          count in the rail, and a subscription mounted on the inbox page would
          only fire for the one person already looking at it.

          Renders nothing. It subscribes to `vizserve_pms_notifications` filtered
          to `user_id=eq.<me>` — the same predicate as the "notifications read
          own" policy — and calls `router.refresh()`, which re-runs this layout
          and therefore re-runs the count inside `<SidebarPanel>`. No count is
          computed in the browser and there is no second source of truth for it.

          ⚠️ P11-05 moved that query behind a Suspense boundary, which does not
          change this: a refresh still re-renders the panel, it just no longer
          holds the page back while it does.
        */}
        <RealtimeNotifications userId={context.userId} />

        {/*
          P8-12 — the clock reminder, mounted beside the realtime badge for the
          same reason: it renders nothing, it needs a browser timer, and it has
          to be live on EVERY page. A reminder that only fires while somebody is
          looking at their own time record is a reminder for the one person who
          does not need it.

          ⚠️ IT TAKES NO PROPS AND THIS LAYOUT READS NOTHING FOR IT — a
          correction, not the original design. It was first fed from here, which
          put `loadPunchState`'s six queries plus a preferences read on the
          critical path of EVERY authenticated page. `/timesheet` and `/dtr`
          issue large batches of their own, and the combined burst started
          failing with `TypeError: fetch failed`. The component fetches its own
          state after mount now; see `app/(app)/reminder-actions.ts`.
        */}
        <ShiftReminder />

        <SidebarProvider>
          {/*
            ⚠️ BEHIND A BOUNDARY, so the page does not wait for the rail.

            The eight queries that fill this used to be awaited in the layout
            body, which meant `children` could not render until the project tree
            had come back — on first load AND after every mutation, since
            `router.refresh()` re-renders layouts too.

            The skeleton draws the rail's FRAME at its real width, so nothing in
            the content area moves when the real one arrives.
          */}
          <Suspense fallback={<AppSidebarSkeleton />}>
            <SidebarPanel context={context} />
          </Suspense>

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

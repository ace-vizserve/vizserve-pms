"use client";

import { useState } from "react";
import { Menu } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarNav } from "./sidebar-nav";

/**
 * The sidebar below `md`. Same `SidebarNav`, same items, same role filtering —
 * only the container differs, so the mobile nav cannot drift from the desktop
 * one as modules land.
 *
 * It closes on navigate (`onNavigate`): App Router transitions do not unmount
 * the sheet, so without it the drawer stays open over the page you just opened.
 */
export function MobileNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="-ml-2 md:hidden">
          <Menu className="size-5" />
          <span className="sr-only">Open navigation</span>
        </Button>
      </SheetTrigger>

      <SheetContent side="left" className="w-64 bg-sidebar p-3 pt-12">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarNav items={items} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

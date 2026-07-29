"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/navigation";
import { NavIcon } from "./nav-icon";

export function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

        if (!item.enabled) {
          return (
            <span
              key={item.href}
              aria-disabled="true"
              title={`${item.label} arrives in ${item.phase}`}
              className="flex cursor-not-allowed items-center gap-3 rounded-sm px-3 py-2 text-sm text-muted-foreground/60"
            >
              <NavIcon name={item.icon} className="size-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium tracking-wide text-muted-foreground">
                {item.phase}
              </span>
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-sm px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            <NavIcon name={item.icon} className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

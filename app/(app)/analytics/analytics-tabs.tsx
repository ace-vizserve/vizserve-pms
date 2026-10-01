"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

export const ANALYTICS_TABS = [
  { href: "/analytics", label: "Workload" },
  { href: "/analytics/delivery", label: "Delivery & quality" },
  { href: "/analytics/time", label: "Time & attendance" },
  { href: "/analytics/client", label: "Client results" },
  { href: "/analytics/people", label: "People" },
] as const;

/**
 * P15-02 — the Analytics sections. Real routes, so each is a link and a
 * bookmark; the query string rides along so a department or period chosen on
 * one tab is still chosen on the next.
 */
export function AnalyticsTabs() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();

  return (
    <nav aria-label="Analytics sections" className="-mb-1 flex gap-1 overflow-x-auto border-b">
      {ANALYTICS_TABS.map((tab) => {
        const active =
          tab.href === "/analytics" ? pathname === "/analytics" : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={query ? `${tab.href}?${query}` : tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

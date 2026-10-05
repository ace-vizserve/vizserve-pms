import Link from "next/link";

import { cn } from "@/lib/utils";

export type LinkTab = {
  key: string;
  label: string;
  href: string;
  /** Shown after the label. Omit when the count is not known. */
  count?: number;
};

/**
 * Tabs that are links — the selected one lives in the URL, so a tab is a
 * bookmark and the server renders only its table. Same look as the Analytics
 * sections (`analytics-tabs.tsx`), which route between pages instead.
 *
 * ONE TABLE PER SCREEN. Two tables stacked on a page make the second one
 * invisible below the fold of the first; put each behind its own tab.
 */
export function LinkTabs({
  tabs,
  active,
  label,
}: {
  tabs: LinkTab[];
  active: string;
  /** The nav's accessible name. */
  label: string;
}) {
  return (
    <nav aria-label={label} className="-mb-1 flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
            tab.key === active
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{tab.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The breadcrumb is the page label — most pages carry no <h1> at all, following
 * the template. That works there because every route is flat and friendly
 * (/transactions, /budgets). Ours are not: /requests/<uuid> would render a raw
 * UUID as the page title.
 *
 * So detail pages supply their own label. The page is a server component that
 * has already fetched the record, but the breadcrumb lives above it in the
 * layout — hence a context the page writes into on mount rather than a prop.
 */
const BreadcrumbLabelContext = React.createContext<{
  setLabel: (value: string | null) => void;
  setTrail: (value: BreadcrumbTrailItem[] | null) => void;
} | null>(null);

/**
 * One crumb of a page-supplied trail. `menu` turns the crumb into a switcher —
 * the list crumb uses it to jump to a sibling list without going back to the
 * index.
 */
export type BreadcrumbTrailItem = {
  label: string;
  href?: string;
  menu?: { label: string; href: string; current?: boolean }[];
};

export function BreadcrumbLabelProvider({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = React.useState<string | null>(null);
  const [trail, setTrail] = React.useState<BreadcrumbTrailItem[] | null>(null);
  const value = React.useMemo(() => ({ setLabel, setTrail }), []);
  const current = React.useMemo(() => ({ label, trail }), [label, trail]);

  return (
    <BreadcrumbLabelContext.Provider value={value}>
      <CurrentLabelContext.Provider value={current}>{children}</CurrentLabelContext.Provider>
    </BreadcrumbLabelContext.Provider>
  );
}

const CurrentLabelContext = React.createContext<{
  label: string | null;
  trail: BreadcrumbTrailItem[] | null;
}>({ label: null, trail: null });

/**
 * Rendered by a detail page to name itself in the breadcrumb:
 *   <BreadcrumbLabel value={request.reference_no} />
 *
 * Clears on unmount so a stale reference number cannot survive a navigation to
 * a sibling route.
 */
export function BreadcrumbLabel({ value }: { value: string }) {
  const context = React.useContext(BreadcrumbLabelContext);
  const setLabel = context?.setLabel;

  React.useEffect(() => {
    setLabel?.(value);
    return () => setLabel?.(null);
  }, [setLabel, value]);

  return null;
}

/**
 * Rendered by a page whose URL does not describe where it sits — `/tasks?list=`
 * and `/tasks/<uuid>` both live inside Department › Folder › List, and nothing
 * in the path says so. The trail REPLACES the path-derived crumbs while mounted.
 *
 * Keyed on its serialised form, so a fresh array each render is not a new
 * value and cannot loop the provider.
 */
export function BreadcrumbTrail({ items }: { items: BreadcrumbTrailItem[] }) {
  const context = React.useContext(BreadcrumbLabelContext);
  const setTrail = context?.setTrail;
  const key = JSON.stringify(items);

  React.useEffect(() => {
    setTrail?.(JSON.parse(key) as BreadcrumbTrailItem[]);
    return () => setTrail?.(null);
  }, [setTrail, key]);

  return null;
}

/** Static segments we can name without a lookup. */
const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  forms: "Forms",
  new: "New",
  requests: "Requests",
  analytics: "Analytics",
  reports: "Reports",
  people: "People",
  delivery: "Delivery & quality",
  time: "Time & attendance",
  client: "Client results",
  tasks: "Tasks",
  board: "Board",
  lists: "Lists",
  dtr: "DTR",
  approvals: "Approvals",
  inbox: "Inbox",
  timesheet: "Timesheet",
  // /timesheet/history and /approvals/leave — both first-person pages.
  history: "My submissions",
  leave: "My leave",
  admin: "Admin",
  users: "Users",
  holidays: "Holidays",
  events: "Events",
  // Two words, so the fallback title-caser cannot produce it — "Audit" alone
  // reads as a verb on a page whose whole point is that it is a record.
  audit: "Audit trail",
};

/** Anything that is plainly an id rather than a readable segment. */
function isOpaqueId(segment: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || /^\d+$/.test(segment);
}

function labelFor(segment: string) {
  return SEGMENT_LABELS[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
}

export function DynamicBreadcrumb() {
  const pathname = usePathname();
  const { label: detailLabel, trail } = React.useContext(CurrentLabelContext);

  if (trail && trail.length > 0) return <TrailBreadcrumb items={trail} />;

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const href = `/${segments.slice(0, index + 1).join("/")}`;

          // An id segment shows the page's own label if it supplied one, and is
          // otherwise dropped — a bare UUID in a breadcrumb tells nobody
          // anything.
          let text: string;
          if (isOpaqueId(segment)) {
            if (!detailLabel) return null;
            text = detailLabel;
          } else {
            text = labelFor(segment);
          }

          return (
            <React.Fragment key={href}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem className={index === 0 && segments.length > 1 ? "hidden md:block" : undefined}>
                {isLast ? (
                  <BreadcrumbPage>{text}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={href} />}>{text}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The page-supplied trail. On a phone only the last two crumbs show — the
 * place you are and the one above it — and the last truncates rather than
 * wrapping the 56px bar onto a second line. The full name stays reachable
 * through `title`.
 */
function TrailBreadcrumb({ items }: { items: BreadcrumbTrailItem[] }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const early = index < items.length - 2;
          const text = <span className="truncate">{item.label}</span>;

          return (
            <React.Fragment key={`${index}:${item.label}`}>
              {index > 0 ? <BreadcrumbSeparator className={cn(index < items.length - 1 && "hidden md:block")} /> : null}
              <BreadcrumbItem
                title={item.label}
                className={cn(
                  "min-w-0",
                  early && "hidden md:inline-flex",
                  isLast ? "max-w-[55vw] md:max-w-md" : "max-w-40 md:max-w-56",
                )}
              >
                {item.menu && item.menu.length > 1 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className={cn(
                        "inline-flex min-w-0 items-center gap-1 rounded-sm px-1 transition-colors hover:text-foreground",
                        isLast && "text-foreground",
                      )}
                    >
                      {text}
                      <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                      <span className="sr-only">, switch list</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-80 w-60">
                      {item.menu.map((entry) => (
                        <DropdownMenuItem
                          key={entry.href}
                          render={<Link href={entry.href} aria-current={entry.current ? "page" : undefined} />}
                          className={cn(entry.current && "font-medium text-foreground")}
                        >
                          <span className="truncate">{entry.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : isLast ? (
                  <BreadcrumbPage className="truncate">{item.label}</BreadcrumbPage>
                ) : item.href ? (
                  <BreadcrumbLink className="min-w-0 truncate" render={<Link href={item.href} />}>
                    {item.label}
                  </BreadcrumbLink>
                ) : (
                  text
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

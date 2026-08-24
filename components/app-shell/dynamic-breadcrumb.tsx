"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

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
} | null>(null);

export function BreadcrumbLabelProvider({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = React.useState<string | null>(null);
  const value = React.useMemo(() => ({ setLabel }), []);

  return (
    <BreadcrumbLabelContext.Provider value={value}>
      <CurrentLabelContext.Provider value={label}>{children}</CurrentLabelContext.Provider>
    </BreadcrumbLabelContext.Provider>
  );
}

const CurrentLabelContext = React.createContext<string | null>(null);

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

/** Static segments we can name without a lookup. */
const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  forms: "Forms",
  new: "New",
  requests: "Requests",
  tasks: "Tasks",
  board: "Board",
  lists: "Lists",
  dtr: "DTR",
  approvals: "Approvals",
  inbox: "Inbox",
  timesheet: "Timesheet",
  admin: "Admin",
  users: "Users",
  holidays: "Holidays",
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
  const detailLabel = React.useContext(CurrentLabelContext);

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

"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LayoutGrid, LayoutList } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one bar that says where you are and lets you leave.
 *
 * It replaces two separate affordances that kept losing each other: the list
 * page had a "Board view" button and the board had a "List view" button, and
 * each was a plain link that dropped every filter on the way through — so
 * switching view from a filtered list landed you on an unfiltered board with no
 * way back to what you were looking at. The scope tabs (All / Mine / Waiting on
 * my QA) lived inside the list's filter panel, which meant the board had no way
 * to set `?view=` at all even though it reads it.
 *
 * Both controls now live here, render identically on both routes, and carry the
 * whole query string across. Switching view is a change of SHAPE, never a
 * change of what you are looking at.
 *
 * They are links, not buttons — they navigate (§2.1). The active one is marked
 * with `aria-current`, so the state survives greyscale and a screen reader.
 */

/**
 * `carries` is which query parameters survive the switch.
 *
 * The list can express every filter; the board can only express scope. Carrying
 * `status` onto a board that is ORGANISED by status would leave the URL claiming
 * a filter the board neither applies nor offers a way to clear — a trap, not a
 * convenience. The board answers "what is in QA" by shape instead. Coming back
 * the other way, everything is carried, so a scope chosen on the board is still
 * the scope on the list.
 */
const VIEWS = [
  { key: "list", href: "/tasks", label: "List", icon: LayoutList, carries: null },
  {
    key: "board",
    href: "/tasks/board",
    label: "Board",
    icon: LayoutGrid,
    carries: ["view", "kind"],
  },
] as const;

const SCOPES = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "qa", label: "Waiting on my QA" },
] as const;

/**
 * Client work and internal work are two different jobs, so they get two
 * different lists.
 *
 * They share a table and a status enum and almost nothing else: a client task
 * is a contract with gates that exist to protect somebody outside the company,
 * and an internal task is a board card several people share and anyone can
 * drag. Mixing them means every row on the page answers "what can I do with
 * this" differently from the one above it.
 *
 * "Internal" INCLUDES personal work, which is why there are two tabs and not
 * three — `scopeAllows("internal", "personal")` is true, and a personal task is
 * internal work whose owner may also close it. Splitting them here would make
 * the page argue with the transition rules.
 *
 * `all` is the absence of the parameter, so the default hides nothing.
 */
const KINDS = [
  { value: "all", label: "All work" },
  { value: "internal", label: "Internal" },
  { value: "client", label: "Client" },
] as const;

/** The segmented track. Flat — it is a place, not a control (elevation rule). */
const TRACK = "flex shrink-0 items-center gap-1 rounded-lg border bg-muted p-1";

/** The thumb is the only lifted thing in the group, which is what marks it. */
const SEGMENT =
  "inline-flex items-center gap-1.5 rounded-sm border border-transparent px-2.5 py-1 text-xs font-[550] whitespace-nowrap text-muted-foreground transition-all hover:text-foreground";
const SEGMENT_ON = "border-border bg-card grade-raised text-foreground shadow-raised";

export function TaskToolbar({ view }: { view: "list" | "board" }) {
  const pathname = usePathname();
  const params = useSearchParams();

  const scope = params.get("view") ?? "all";
  const kind = params.get("kind") ?? "all";

  /** The other route, keeping whatever that route can honestly honour. */
  function withParams(href: string, carries: readonly string[] | null) {
    const next = carries
      ? new URLSearchParams([...params.entries()].filter(([key]) => carries.includes(key)))
      : new URLSearchParams(params.toString());
    const query = next.toString();
    return query ? `${href}?${query}` : href;
  }

  /** Same route, different scope. `all` is the absence of the parameter. */
  function withScope(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("view");
    else next.set("view", value);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  /** Same, for the client/internal split. */
  function withKind(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("kind");
    else next.set("kind", value);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className={TRACK} role="group" aria-label="View">
        {VIEWS.map((item) => {
          const active = item.key === view;
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={withParams(item.href, item.carries)}
              aria-current={active ? "page" : undefined}
              className={cn(SEGMENT, active && SEGMENT_ON)}
            >
              <Icon className="size-3.5" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </div>

      <div className={TRACK} role="group" aria-label="Kind of work">
        {KINDS.map((item) => {
          const active = kind === item.value;

          return (
            <Link
              key={item.value}
              href={withKind(item.value)}
              aria-current={active ? "true" : undefined}
              className={cn(SEGMENT, active && SEGMENT_ON)}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      <div className={TRACK} role="group" aria-label="Scope">
        {SCOPES.map((item) => {
          const active = scope === item.value;

          return (
            <Link
              key={item.value}
              href={withScope(item.value)}
              aria-current={active ? "true" : undefined}
              className={cn(SEGMENT, active && SEGMENT_ON)}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

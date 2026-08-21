import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The bento's shared parts.
 *
 * A cell is FLAT-bordered with a lift (`shadow-raised-lg`) — the system's panel,
 * same as a table shell or a status group. What is new here is that a cell is a
 * flex column whose body grows: in a grid row, a short cell is stretched to the
 * height of the tallest one beside it, and without the growing body its content
 * pools at the top under a band of nothing. That band was the entire complaint
 * about the first two passes at this page.
 *
 * Pair cells by CONTENT VOLUME, not by importance. Two cells on one row should
 * hold roughly the same amount, or the stretch has to invent the difference.
 */
export function Cell({
  span = "",
  label,
  children,
  className,
}: {
  /** Grid span classes, e.g. `sm:col-span-3`. */
  span?: string;
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg",
        span,
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A cell's heading row. `action` is an icon link, never a typed arrow. */
export function CellHead({
  title,
  count,
  tone = "neutral",
  action,
  children,
}: {
  title: string;
  count?: number;
  tone?: "neutral" | "warning" | "info" | "brand";
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const COUNT_TONE = {
    neutral: "border-border bg-muted text-foreground-muted",
    warning: "border-warning-border bg-warning-subtle text-warning",
    info: "border-info-border bg-info-subtle text-info",
    brand: "border-accent-border bg-accent text-accent-foreground",
  } as const;

  return (
    // py-1.5 and text-sm. Four cell headings plus the calendar's own is five of
    // these stacked down the page, so a few pixels each is most of a calendar
    // row — and at 14px the heading still outweighs the 12px content under it.
    <div className="flex shrink-0 items-center gap-2 border-b px-3.5 py-1.5">
      <h2 className="text-sm font-semibold tracking-[-0.012em]">{title}</h2>
      {typeof count === "number" ? (
        <span
          className={cn(
            "inline-flex h-5.5 shrink-0 items-center rounded-sm border px-1.5 text-2xs font-semibold tabular-nums",
            COUNT_TONE[tone],
          )}
        >
          {count}
        </span>
      ) : null}
      {children}
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}

/** The growing body. Rows inside it distribute rather than stacking at the top. */
export function CellBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("flex min-h-0 flex-1 flex-col", className)}>{children}</div>;
}

/**
 * Three numbers in one cell, not three cells around one number each.
 *
 * The three-tile version left each figure marooned in its own box, and the row
 * stretched to whatever the tallest neighbour needed. One cell divided by
 * hairlines carries the same three facts in a third of the height.
 *
 * `StatTile` is still the right component for a page whose whole subject is one
 * number. This is not that page.
 */
export function StatStrip({
  stats,
  span = "",
}: {
  stats: { label: string; value: number; href?: string }[];
  span?: string;
}) {
  return (
    <Cell span={span} label="Your numbers">
      <CellBody className="flex-row">
        {stats.map((stat, index) => {
          const inner = (
            <>
              <span className="text-2xs leading-4 text-muted-foreground">{stat.label}</span>
              {/* text-xl, not 2xl. These are three small counts, and at 30px
                  they were the loudest thing on a page whose actual subject is
                  the work underneath them. */}
              <span className="text-xl font-semibold tracking-[-0.02em] tabular-nums">
                {stat.value}
              </span>
            </>
          );

          return (
            <div
              key={stat.label}
              className={cn(
                "flex min-w-0 flex-1 basis-0 flex-col justify-center gap-0.5 px-3 py-2",
                index < stats.length - 1 && "border-r",
              )}
            >
              {stat.href ? (
                <Link href={stat.href} className="flex flex-col gap-0.5 rounded-sm hover:underline">
                  {inner}
                </Link>
              ) : (
                inner
              )}
            </div>
          );
        })}
      </CellBody>
    </Cell>
  );
}

/** `Amier Bautista` → `AB`. Same rule as the board card. */
export function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

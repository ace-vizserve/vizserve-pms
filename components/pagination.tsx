import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { PageSizeSelect } from "@/components/page-size-select";

/** Rows-per-page choices, smallest first. The first is the default. */
export const PAGE_SIZES = [20, 50, 100] as const;

/**
 * Clamps a `?size=` param to the allowed set.
 *
 * Not decoration: `.range()` takes whatever it is given, so an unvalidated
 * `?size=100000` is one URL edit away from pulling every row a person can see
 * in a single query.
 */
export function resolvePageSize(raw: string | undefined): number {
  const value = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(value) ? value : PAGE_SIZES[0];
}

/** Clamps `?page=` to a whole number ≥ 1. Guards a negative range offset. */
export function resolvePage(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/**
 * The page numbers to show, with gaps.
 *
 * Windowed rather than listing every page: an inbox with 40 pages would
 * otherwise render 40 buttons and wrap onto three lines on a phone. The window
 * keeps first and last always reachable and shows the current page's
 * neighbours, which is what people actually use.
 *
 * Exported for tests — the off-by-ones here (a gap of exactly one page should
 * render that page, not an ellipsis) are the kind that survive a visual check.
 */
export function pageWindow(page: number, lastPage: number): (number | "gap")[] {
  if (lastPage <= 7) {
    return Array.from({ length: lastPage }, (_, index) => index + 1);
  }

  const items: (number | "gap")[] = [1];

  const start = Math.max(2, page - 1);
  const end = Math.min(lastPage - 1, page + 1);

  // A gap hiding a single page is worse than the page: same width, less use.
  if (start > 2) items.push(start === 3 ? 2 : "gap");
  for (let n = start; n <= end; n += 1) items.push(n);
  if (end < lastPage - 1) items.push(end === lastPage - 2 ? lastPage - 1 : "gap");

  items.push(lastPage);
  return items;
}

/**
 * Server-rendered pagination: rows-per-page, Prev, numbered pages, Next.
 *
 * The page links are `<Link>`s rather than buttons, so Back works, a page is
 * bookmarkable, and middle-click opens it in a tab. Only the size selector is
 * client-side, because a `<select>` has to react to a choice.
 */
export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
  basePath,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Builds the href for a page, preserving whatever filters are active. */
  hrefFor: (page: number) => string;
  /** Where the size selector should navigate, e.g. `/inbox`. */
  basePath: string;
  className?: string;
}) {
  // Below the smallest option no choice of page size changes anything, so the
  // whole bar is noise on a short list.
  if (total <= PAGE_SIZES[0]) return null;

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, lastPage);

  const first = (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  const stepClass = cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1");
  const stepDisabled = cn(stepClass, "pointer-events-none opacity-50");

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <div className="flex items-center gap-3">
        <PageSizeSelect value={pageSize} options={PAGE_SIZES} basePath={basePath} />
        {/* The range in words. "Page 2 of 5" alone does not say how much is
            left; "21–40 of 87" does. */}
        <p className="text-xs text-muted-foreground" aria-live="polite">
          <span className="tabular-nums">
            {first}–{last}
          </span>{" "}
          of <span className="tabular-nums">{total}</span>
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        {current > 1 ? (
          <Link href={hrefFor(current - 1)} className={stepClass} rel="prev">
            <ChevronLeft className="size-4" />
            Prev
          </Link>
        ) : (
          // Present but inert, so the numbers do not shift sideways on page 1.
          <span className={stepDisabled} aria-disabled="true">
            <ChevronLeft className="size-4" />
            Prev
          </span>
        )}

        {pageWindow(current, lastPage).map((item, index) =>
          item === "gap" ? (
            <span key={`gap-${index}`} aria-hidden className="px-1 text-xs text-muted-foreground">
              …
            </span>
          ) : item === current ? (
            // The current page is not a link — there is nowhere to go. Marked
            // with aria-current so it is announced as the position, not as one
            // more button.
            <span
              key={item}
              aria-current="page"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "pointer-events-none w-9 border-primary font-semibold text-primary tabular-nums",
              )}
            >
              {item}
            </span>
          ) : (
            <Link
              key={item}
              href={hrefFor(item)}
              aria-label={`Page ${item}`}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "w-9 tabular-nums")}
            >
              {item}
            </Link>
          ),
        )}

        {current < lastPage ? (
          <Link href={hrefFor(current + 1)} className={stepClass} rel="next">
            Next
            <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span className={stepDisabled} aria-disabled="true">
            Next
            <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </nav>
  );
}

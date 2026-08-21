import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  MONTH_GRID_WEEKDAYS,
  addMonths,
  formatMonthYear,
  isSameMonth,
  monthGrid,
} from "@/lib/dates";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * P7-10 — who is out, and when.
 *
 * The data comes from `vizserve_pms_leave_calendar`, a SECURITY DEFINER
 * function, and NOT from a direct read of `vizserve_pms_internal_requests`.
 * That is the whole design: the table's policy scopes rows to the requester and
 * to leads of the department, which is right for a request carrying a `reason`
 * — somebody's medical appointment — and useless for a calendar, where a member
 * would see only themselves. The function projects name and dates and withholds
 * the reason, which RLS cannot do because a policy grants a row, not a column.
 *
 * TWO KINDS OF ENTRY, and the difference is a privacy rule rather than a
 * display one:
 *
 *   approved   everyone's, from the function
 *   pending    YOURS ONLY, read through the ordinary policy by the page
 *
 * A pending request is not yet a fact. Broadcasting it would tell the whole
 * company that someone has asked for time off before their own Team Leader has
 * seen it, which is how people learn to stop filing requests in the system.
 */

export type LeaveSpan = {
  userId: string;
  name: string;
  start: string;
  end: string;
  pending?: boolean;
};

/** What lands on a given day, resolved once rather than per cell per span. */
function spansByDay(spans: LeaveSpan[], days: string[]): Map<string, LeaveSpan[]> {
  const byDay = new Map<string, LeaveSpan[]>();

  for (const day of days) {
    // A span is a closed interval, so string comparison on `YYYY-MM-DD` is the
    // whole test — the format sorts lexicographically, which is the one thing
    // it is good for.
    const hits = spans.filter((span) => span.start <= day && span.end >= day);
    if (hits.length > 0) byDay.set(day, hits);
  }

  return byDay;
}

/** `Rina Cruz` → `R. Cruz`. A full name does not fit a calendar cell. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "—";

  return `${parts[0]![0]!.toUpperCase()}. ${parts[parts.length - 1]}`;
}

export function LeaveCalendar({
  month,
  today,
  spans,
  className,
}: {
  /** Any date in the month being shown. */
  month: string;
  today: string;
  spans: LeaveSpan[];
  className?: string;
}) {
  const days = monthGrid(month);
  const byDay = spansByDay(spans, days);

  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);

  return (
    <section
      aria-label="Leave and vacation"
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg",
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3.5 py-1.5">
        <h2 className="text-sm font-semibold tracking-[-0.012em]">Leave &amp; vacation</h2>
        <p className="text-xs text-muted-foreground">{formatMonthYear(month)} · everyone</p>

        {/* Icons, not typed arrows. Each is a real link with an accessible name
            — an icon-only control that cannot be announced is not a control. */}
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href={previous ? `/?month=${previous}` : "/"}
            aria-label={`Previous month, ${previous ? formatMonthYear(previous) : ""}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronLeft />
          </Link>
          <Link
            href={next ? `/?month=${next}` : "/"}
            aria-label={`Next month, ${next ? formatMonthYear(next) : ""}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronRight />
          </Link>
        </div>
      </div>

      {/* min-h-0 so this can shrink inside the bounded page. Without it the
          grid below holds its content height and the "no scroll" upstairs just
          moves the overflow somewhere less visible. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-2.5">
        <div className="grid grid-cols-7 gap-1">
          {MONTH_GRID_WEEKDAYS.map((weekday) => (
            <div
              key={weekday}
              className="text-center text-2xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {weekday}
            </div>
          ))}
        </div>

        <div className="grid flex-1 auto-rows-fr grid-cols-7 gap-1">
          {days.map((day) => {
            const inMonth = isSameMonth(day, month);
            const hits = byDay.get(day) ?? [];
            const pendingOnly = hits.length > 0 && hits.every((span) => span.pending);
            const isToday = day === today;

            return (
              <div
                key={day}
                className={cn(
                  // min-h-8, down from min-h-11. `auto-rows-fr` above shares the
                  // leftover height between the six week rows, so this is only a
                  // FLOOR — on a tall screen the cells still grow. Lowering it is
                  // what lets six rows fit a 1080p viewport at all: at 44px the
                  // grid alone demanded ~290px it did not have.
                  "flex min-h-8 flex-col gap-0.5 overflow-hidden rounded-md border p-1 px-1.5",
                  // Order matters: today's ring wins over a leave tint, because
                  // "where am I" is the first question anyone asks of a
                  // calendar. The leave still reads from the name in the cell.
                  !inMonth
                    ? "border-border/60 bg-muted/40"
                    : isToday
                      ? "border-accent-border bg-accent"
                      : hits.length === 0
                        ? "border-border bg-muted/50"
                        : pendingOnly
                          ? "border-warning-border bg-warning-subtle"
                          : "border-info-border bg-info-subtle",
                )}
              >
                <span
                  className={cn(
                    "text-2xs font-semibold tabular-nums",
                    !inMonth
                      ? "text-foreground-faint"
                      : isToday
                        ? "text-accent-foreground"
                        : hits.length === 0
                          ? "text-muted-foreground"
                          : pendingOnly
                            ? "text-warning"
                            : "text-info",
                  )}
                >
                  {Number(day.slice(8, 10))}
                  {isToday ? <span className="sr-only"> — today</span> : null}
                </span>

                {/* Two names, then a count. Three names in a 90px cell is three
                    truncated names, which tells you less than "+2 more". */}
                {hits.slice(0, 2).map((span) => (
                  <span
                    key={`${span.userId}-${span.start}`}
                    title={`${span.name}${span.pending ? " — pending" : ""}`}
                    className={cn(
                      "truncate text-2xs font-medium",
                      span.pending ? "text-warning" : "text-info",
                    )}
                  >
                    {shortName(span.name)}
                  </span>
                ))}
                {hits.length > 2 ? (
                  <span className="text-2xs text-muted-foreground">+{hits.length - 2} more</span>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* The legend is not decoration here. Two tints carry two different
            facts, and the design rule is that colour is never the only carrier
            — the names in the cells and this key are what actually say which
            is which. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-xs border border-info-border bg-info-subtle"
            />
            Approved leave
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-xs border border-warning-border bg-warning-subtle"
            />
            Your pending leave
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-xs border border-accent-border bg-accent"
            />
            Today
          </span>
          <span className="ml-auto">Names and dates only — never the reason.</span>
        </div>
      </div>
    </section>
  );
}

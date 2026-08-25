import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  MONTH_GRID_WEEKDAYS,
  addMonths,
  formatMonthYear,
  isSameMonth,
  monthGrid,
} from "@/lib/dates";
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  EVENT_CATEGORY_TONE,
  type EventCategory,
} from "@/lib/schemas/events";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

import { LeaveEntry, MoreLeaveTooltip } from "./leave-entry";
import type { LeaveSpan } from "./leave-entry";

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
 *
 * P7-35 — AND HOLIDAYS, which are a third kind of entry rather than a third kind
 * of absence. Leave is a fact about a person; a holiday is a fact about the day,
 * so it paints the whole cell instead of adding a name to it. It comes from
 * `vizserve_pms_holidays` through the ordinary policy — every active user may
 * read that table, and there is nothing private about which days the company is
 * shut, so this one needs no SECURITY DEFINER function.
 *
 * A HOLIDAY OUTRANKS LEAVE in the cell, because a day nobody works is not a day
 * somebody is absent. Leave spanning a holiday still lists its names — the
 * request genuinely covers it — but the day reads as closed first.
 *
 * P7-42 — AND A HOVER CARD, which moved the line this component had held since
 * P7-10. The cells still carry a shortened name and nothing else; the halves and
 * the leave type now live one hover away, in `leave-entry.tsx`.
 *
 * THE LINE IS DRAWN IN POSTGRES, NOT HERE, and that is the part worth keeping
 * straight. `vizserve_pms_leave_types.calendar_visibility` gives every type one
 * of three levels, and the function applies them before a row reaches this file:
 *
 *   FULL          name, real label, dates and halves
 *   LABEL_HIDDEN  name and dates; `typeLabel` arrives null and reads "On leave"
 *   HIDDEN        the row does not arrive at all
 *
 * So THE CALENDAR IS INCOMPLETE ON PURPOSE. Special Leave for Women and VAWC
 * leave are statutory confidences (RA 9710; RA 9262 §44, which attaches a
 * penalty to disclosure), and a colleague will believe those people are in the
 * office. That is the accepted price, the legend admits it in as many words, and
 * the absence is still visible to the requester, to the lead deciding it, and in
 * the DTR and the payroll export.
 *
 * Your own leave is exempt from every level — the rule keys off `auth.uid()` —
 * so you always see your own row in full on your own calendar.
 */

/**
 * Re-exported from the client leaf that owns it, so the dependency runs one way
 * and `app/page.tsx` keeps importing the type from the component it feeds.
 */
export type { LeaveSpan } from "./leave-entry";

/** P7-35. A day nobody is scheduled to work. `date` is `YYYY-MM-DD`. */
export type Holiday = { date: string; name: string };

/**
 * P7-46 — something HAPPENING on a day, as opposed to a day off.
 *
 * A span like leave, not a single date like a holiday, because an offsite
 * runs Tuesday to Thursday. `scope` is what the cell prints — "Company-wide"
 * or the department name — since for a department event the word "Department"
 * says nothing the team name does not say better.
 */
export type CalendarEvent = {
  id: string;
  title: string;
  category: EventCategory;
  scope: string;
  start: string;
  end: string;
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

export function LeaveCalendar({
  month,
  today,
  spans,
  holidays = [],
  events = [],
  className,
}: {
  /** Any date in the month being shown. */
  month: string;
  today: string;
  spans: LeaveSpan[];
  /** P7-35. Admin-maintained at /admin/holidays; read-only here. */
  holidays?: Holiday[];
  /** P7-46. Admin-maintained at /admin/events; read-only here. */
  events?: CalendarEvent[];
  className?: string;
}) {
  const days = monthGrid(month);
  const byDay = spansByDay(spans, days);
  // A Map rather than a scan per cell: the grid is 42 cells and the list is a
  // year of holidays, so this is one pass instead of 42 of them.
  const holidayByDay = new Map(holidays.map((holiday) => [holiday.date, holiday.name]));

  /*
   * P7-46 — events per day.
   *
   * Resolved once for the whole grid rather than filtered per cell, the same
   * way `spansByDay` handles leave. A closed interval compared as strings works
   * because `YYYY-MM-DD` sorts lexicographically — the one thing that format is
   * good for, and the reason every date in this app is stored as one.
   */
  const eventsByDay = new Map<string, CalendarEvent[]>();
  for (const day of days) {
    const hits = events.filter((event) => event.start <= day && event.end >= day);
    if (hits.length > 0) eventsByDay.set(day, hits);
  }

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

      <div className="flex flex-1 flex-col gap-1 p-2.5">
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

        {/* `minmax(3.5rem,auto)`, NOT `auto-rows-fr`.

            `auto-rows-fr` expands to `minmax(0,1fr)`, and the zero is the whole
            problem: it lets a row shrink to nothing while each cell's own
            `overflow-hidden` quietly amputates the names inside it. That is the
            "cramped" grid — six rows squeezed to ~36px, drawing the top half of
            a name and no more.

            `auto` as the maximum rather than `1fr` because the page scrolls now.
            A row takes the height its fullest cell needs, so a week where three
            people are out is taller than an empty one instead of every row
            paying for the worst case, and 3.5rem keeps an empty week from
            collapsing to a line of dates. */}
        <div className="grid auto-rows-[minmax(3.5rem,auto)] grid-cols-7 gap-1">
          {days.map((day) => {
            const inMonth = isSameMonth(day, month);
            const hits = byDay.get(day) ?? [];
            const pendingOnly = hits.length > 0 && hits.every((span) => span.pending);
            const isToday = day === today;
            const holiday = holidayByDay.get(day);
            const dayEvents = eventsByDay.get(day) ?? [];
            // Named once rather than written as `holiday ? 1 : 2` in three
            // places — the slice and the counter that reads it have to agree,
            // and they are eight lines apart.
            const shown = holiday ? 1 : 2;

            return (
              <div
                key={day}
                className={cn(
                  // The real floor is the row's `minmax(3.5rem,auto)` above; this
                  // min-h-8 is the older, smaller one and now only matters if
                  // that ever changes. `overflow-hidden` stays for the truncated
                  // holiday name, NOT to absorb a squeeze — the row grows to its
                  // content, so there is nothing left for it to cut vertically.
                  "flex min-h-8 flex-col gap-0.5 overflow-hidden rounded-md border p-1 px-1.5",
                  // Order matters: today's ring wins over a leave tint, because
                  // "where am I" is the first question anyone asks of a
                  // calendar. The leave still reads from the name in the cell.
                  !inMonth
                    ? "border-border/60 bg-muted/40"
                    : isToday
                      ? "border-accent-border bg-accent"
                      : // P7-35. Above leave, below today. A closed day is a fact
                        // about the calendar, but "where am I" is still the first
                        // question anybody asks of one.
                        holiday
                        ? "border-success-border bg-success-subtle"
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
                        : holiday
                          ? "text-success"
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

                {/* P7-35. The holiday name comes first, because it explains the
                    whole cell rather than one person in it. `title` carries the
                    full text: "Immaculate Conception" does not fit 90px, and the
                    tint alone would not say WHICH holiday it is. */}
                {holiday ? (
                  <span title={holiday} className="truncate text-2xs font-semibold text-success">
                    {holiday}
                  </span>
                ) : null}

                {/* P7-46 — events, under any holiday name and above the leave
                    names. The ordering is the cell's priority: a day nobody
                    works outranks a thing happening on it, which outranks who
                    happens to be away.

                    Each carries its TITLE, so the category colour is never the
                    only thing saying what it is, and a `title` attribute with
                    the scope because "Q4 Town Hall" in a 90px cell is going to
                    truncate however careful the wording. */}
                {dayEvents.slice(0, 1).map((event) => (
                  <span
                    key={event.id}
                    title={`${event.title} — ${event.scope}`}
                    className={cn(
                      "truncate text-2xs font-medium",
                      EVENT_CATEGORY_TONE[event.category].text,
                    )}
                  >
                    {event.title}
                  </span>
                ))}
                {dayEvents.length > 1 ? (
                  <span className="text-2xs text-muted-foreground">
                    +{dayEvents.length - 1} event{dayEvents.length - 1 === 1 ? "" : "s"}
                  </span>
                ) : null}

                {/* Two names, then a count. Three names in a 90px cell is three
                    truncated names, which tells you less than "+2 more". One
                    fewer on a holiday cell, since the holiday name took a line. */}
                {hits.slice(0, shown).map((span) => (
                  <LeaveEntry key={`${span.userId}-${span.start}`} span={span} day={day} />
                ))}
                {/* Counted from what was actually rendered rather than a fixed 2,
                    which is what keeps this number true on a holiday cell. P7-42
                    made it hoverable: the names behind it have nowhere else to be
                    read, because a cell deliberately links to nothing. */}
                {hits.length > shown ? (
                  <MoreLeaveTooltip spans={hits.slice(shown)} day={day} />
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
              className="size-2.5 shrink-0 rounded-xs border border-success-border bg-success-subtle"
            />
            Holiday
          </span>

          {/* P7-46. One swatch per category, and the label beside it is what
              actually carries the meaning — the tints exist so a glance can
              group them, not so colour alone has to be decoded. Rendered from
              the same constant the admin screen and the event pills use, so a
              fourth category could never appear in one place and not the
              other. */}
          {EVENT_CATEGORIES.map((category) => (
            <span key={category} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 rounded-xs border",
                  EVENT_CATEGORY_TONE[category].swatch,
                )}
              />
              {EVENT_CATEGORY_LABELS[category].label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-xs border border-accent-border bg-accent"
            />
            Today
          </span>
          {/* P7-42 rewrote this line, and the second clause is the load-bearing
              half: a calendar that withholds two leave types outright owes its
              readers one sentence saying so, or it is quietly wrong about who is
              in. KEPT TO ONE LINE, and that is a layout constraint rather than a
              stylistic one — the grid above is `flex-1` over six `auto-rows-fr`
              rows with a `min-h-8` floor, so it cannot give height back. A
              legend that wraps to two lines does not shrink the grid, it pushes
              the sixth week under the panel's `overflow-hidden`. The first
              attempt at this sentence ran to 88 characters and did exactly
              that. */}
          <span className="ml-auto">Hover a name for details · some leave is private</span>
        </div>
      </div>
    </section>
  );
}

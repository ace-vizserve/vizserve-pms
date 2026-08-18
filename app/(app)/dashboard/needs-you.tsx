import Link from "next/link";
import { ArrowRight, CircleCheck } from "lucide-react";

import { Chip, type ChipTone } from "@/components/status-badge";
import { cn } from "@/lib/utils";

/**
 * I2 — "Needs you", the mixed queue as ROWS.
 *
 * The approver's queue and a member's own work are the same question asked of
 * different people, so this is one section that fills differently by role rather
 * than two that each go empty for half the company.
 *
 * ORDERED BY URGENCY, NOT BY SOURCE (`needsYouRank`). Every row links to the
 * ENTITY, never to a filtered list that contains it — a dashboard row that lands
 * you on `/tasks?view=mine` has made you do the finding twice.
 *
 * OVERDUE CARRIES THE WORD. House rule, and here it is also the difference
 * between a row you skim and a row you decode.
 */

export type NeedsYouRow = {
  key: string;
  /** The chip. Says which queue this came out of. */
  kind: string;
  tone: ChipTone;
  title: string;
  /** The right-hand column: a date, a person, a duration. Never a status. */
  meta: string;
  /** Rendered after `meta`, in words, for anything urgent. */
  flag?: string;
  href: string;
};

export function NeedsYou({
  rows,
  overflow,
  overflowHref,
  empty,
}: {
  rows: NeedsYouRow[];
  /** How many did not fit. Zero draws nothing. */
  overflow: number;
  overflowHref: string;
  /**
   * The true sentence for an empty queue, from `emptyNeedsYouMessage`.
   *
   * Passed in rather than written here, because only the page knows how much
   * open work exists — and "nothing is due" on its own reads as an empty system
   * when it might just be a quiet week.
   */
  empty: string;
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <h2 className="text-sm font-semibold">Needs you</h2>
        {rows.length > 0 ? (
          <span className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
            {rows.length + overflow}
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="flex items-center gap-2 px-3.5 py-6 text-xs text-muted-foreground">
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
          {empty}
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.key}>
              <Link
                href={row.href}
                className={cn(
                  "flex items-center gap-3 px-3.5 py-2.5 text-xs",
                  "hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
                )}
              >
                <Chip tone={row.tone} label={row.kind} className="h-5 shrink-0 px-1.5" />

                <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>

                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {row.meta}
                  {/* Never colour alone, and never a tint standing in for a
                      word — this is the one column somebody scans. */}
                  {row.flag ? (
                    <span className="ml-1.5 font-semibold text-destructive">{row.flag}</span>
                  ) : null}
                </span>

                <ArrowRight className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* "and N more", because a truncated queue that does not say so is a queue
          somebody works to the bottom of and believes they are finished. */}
      {overflow > 0 ? (
        <Link
          href={overflowHref}
          className="flex items-center gap-1.5 border-t px-3.5 py-2 text-2xs text-muted-foreground hover:text-foreground"
        >
          and {overflow} more
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      ) : null}
    </section>
  );
}

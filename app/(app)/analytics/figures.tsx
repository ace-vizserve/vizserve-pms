import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { formatDate, formatDuration } from "@/lib/dates";
import { percent, type Rate } from "@/lib/performance";
import { cn } from "@/lib/utils";

/**
 * P15-02 — small shared pieces for the Analytics tabs.
 */

/** "72%", or "—" when there is nothing to measure. */
export function pct(rate: Rate): string {
  const value = percent(rate);
  return value === null ? "—" : `${value}%`;
}

/** "72% · 18 of 25", the denominator always beside the rate. */
export function rateHint(rate: Rate, noun: string): string {
  return rate.of === 0 ? `No ${noun} to measure` : `${rate.hit} of ${rate.of} ${noun}`;
}

export function hours(minutes: number): string {
  return minutes > 0 ? formatDuration(minutes) : "0h";
}

export function days(value: number | null): string {
  if (value === null) return "—";
  return value < 1 ? `${Math.round(value * 24)}h` : `${value.toFixed(1)}d`;
}

export function hoursValue(value: number | null): string {
  if (value === null) return "—";
  return value < 1 ? `${Math.round(value * 60)}m` : value < 48 ? `${value.toFixed(1)}h` : `${(value / 24).toFixed(1)}d`;
}

export function periodLabel(period: { from: string; to: string }): string {
  return `${formatDate(period.from)} – ${formatDate(period.to)}`;
}

/**
 * The change against the previous period, in words AND an arrow — never colour
 * alone. `better` says which direction is good for this measure, because
 * "overdue went up" is bad and "completed went up" is good.
 */
export function Delta({
  now,
  before,
  better,
  unit = "",
  format,
  unavailable = null,
}: {
  now: number | null;
  before: number | null;
  better: "up" | "down";
  unit?: string;
  format?: (value: number) => string;
  /** P15-02 — set when the earlier period predates the records; said instead. */
  unavailable?: string | null;
}) {
  if (unavailable) {
    return <span className="text-2xs text-muted-foreground">{unavailable}</span>;
  }
  if (now === null || before === null) {
    return <span className="text-2xs text-muted-foreground">no earlier figure</span>;
  }
  const diff = now - before;
  const rounded = Math.round(diff * 10) / 10;
  if (rounded === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground">
        <Minus aria-hidden className="size-3" />
        same as before
      </span>
    );
  }
  const good = (rounded > 0) === (better === "up");
  const Icon = rounded > 0 ? ArrowUpRight : ArrowDownRight;
  const shown = format ? format(Math.abs(rounded)) : `${Math.abs(rounded)}${unit}`;

  return (
    <span className={cn("inline-flex items-center gap-0.5 text-2xs font-medium", good ? "text-success" : "text-warning")}>
      <Icon aria-hidden className="size-3" />
      {rounded > 0 ? "up" : "down"} {shown} vs before
    </span>
  );
}

/** A figure tile with its comparison underneath. */
export function Figure({
  label,
  value,
  hint,
  delta,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  delta?: React.ReactNode;
  tone?: "warning" | "success";
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-2xl leading-none font-semibold tracking-[-0.032em] tabular-nums",
          tone === "warning" && "text-warning",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {delta}
    </div>
  );
}

/** Errors from the loader, said out loud rather than read as zeros. */
export function LoadErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg border border-destructive-border bg-destructive-subtle p-3 text-xs text-destructive">
      Some figures could not be loaded, so the numbers below may be low. Give whoever is on support this:{" "}
      <code className="text-2xs">{errors.join(" · ")}</code>
    </div>
  );
}

/** A plain read-only table: first column text, the rest numbers. */
export function SimpleTable({
  head,
  rows,
}: {
  head: string[];
  rows: (string | number | React.ReactNode)[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-120 border-collapse text-sm">
        <thead>
          <tr className="border-b">
            {head.map((label, index) => (
              <th
                key={label}
                scope="col"
                className={cn(
                  "px-2 py-2 text-xs font-medium text-muted-foreground",
                  index === 0 ? "text-left" : "text-right",
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-0">
              {row.map((cell, index) =>
                index === 0 ? (
                  <th key={index} scope="row" className="px-2 py-2 text-left font-medium">
                    {cell}
                  </th>
                ) : (
                  <td key={index} className="px-2 py-2 text-right tabular-nums">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** P15-02 — what stands in for the figures while they stream in. */
export function FiguresSkeleton() {
  return (
    <div role="status" aria-label="Loading the figures" className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-lg border bg-muted/60" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-lg border bg-muted/60" />
        <div className="h-56 animate-pulse rounded-lg border bg-muted/60" />
      </div>
      <div className="h-40 animate-pulse rounded-lg border bg-muted/60" />
    </div>
  );
}

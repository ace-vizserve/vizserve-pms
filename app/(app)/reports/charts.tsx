import { cn } from "@/lib/utils";

/**
 * E2 — the app's first charts, and they are plain HTML.
 *
 * No charting library, for the same reason `DataTable` is not built on
 * @tanstack/react-table: a library earns its place at axis ticks, scales and
 * virtualisation, and neither of the two forms here has an axis. A bar whose
 * length is a percentage width is a bar, and it renders on the server with no
 * JavaScript shipped to the browser at all.
 *
 * THE FORM WAS CHOSEN BEFORE THE COLOUR, which is the order the dataviz method
 * insists on. Both questions this page answers are magnitude-and-composition per
 * department — a category axis of at most a handful of departments and one
 * measure — so: horizontal bars, sorted by value, direct-labelled. Not a pie
 * (angles are unreadable at these counts), not a line (departments are not a
 * sequence), and no sparkline anywhere (change-over-time is P6-04's question and
 * P6-04 is explicitly out of this plan).
 *
 * NO DUAL AXIS anywhere on this page. Hours and task counts are two measures of
 * different scale, so they are two charts.
 *
 * EVERY SERIES CARRIES ITS LABEL. The house rule ("state is never conveyed by
 * colour alone") applies to a chart exactly as it does to a status pill, and the
 * validator's contrast WARN on three of the five categorical slots obligates it
 * rather than suggesting it. There is also a table underneath every chart on this
 * page, which is the relief the WARN asks for.
 *
 * No hover tooltip layer, and that is a considered omission rather than an
 * oversight: a tooltip exists to reveal a value the mark does not show, and every
 * bar here is directly labelled with its own number. `title` carries the long
 * form for the truncated department names.
 */

/** A row of one bar. The label and the value are always visible. */
export function BarRow({
  label,
  value,
  max,
  /** Rendered after the number — "h", "tasks". Every figure names its unit. */
  unit,
  /** A second line under the label, for context that is not the measure. */
  note,
  tone = "chart-1",
}: {
  label: string;
  value: number;
  max: number;
  unit?: string;
  note?: string;
  tone?: "chart-1" | "chart-2" | "chart-3";
}) {
  // Guard the divide, and floor the visible width: a bar of 0.3% is a bar
  // somebody reads as nothing rather than as a small number, so a non-zero value
  // always gets a visible stub.
  const percent = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;

  return (
    <div className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3">
      <div className="min-w-0">
        <span className="block truncate text-xs font-medium" title={label}>
          {label}
        </span>
        {note ? <span className="block truncate text-2xs text-muted-foreground">{note}</span> : null}
      </div>

      {/* The track is a place, not a control — flat, no lift. */}
      <div className="h-2.5 min-w-0 overflow-hidden rounded-full bg-muted">
        <div
          // 4px rounded data-end anchored to the baseline: the bar is rounded on
          // the value end only, so the origin stays a straight edge and bars of
          // different lengths still start on one line.
          className={cn("h-full rounded-r-sm", TONE[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>

      <span className="shrink-0 text-xs font-medium tabular-nums">
        {value}
        {unit ? <span className="ml-0.5 text-2xs font-normal text-muted-foreground">{unit}</span> : null}
      </span>
    </div>
  );
}

/**
 * One bar split into three stages, with a legend above and the counts on it.
 *
 * THREE SERIES FROM EIGHT STATUSES, and the reduction is the point. Eight
 * categorical hues is past the point where anybody can hold the legend in their
 * head, and the dataviz rule is that a ninth series folds into "Other" rather
 * than becoming a generated hue — eight was already too many. So the bar carries
 * the three bands the status control already groups by (not started · active ·
 * done), derived from the same two facts, and the per-status detail lives in the
 * table below where a number is a number.
 */
export function StageBar({
  label,
  notStarted,
  active,
  done,
}: {
  label: string;
  notStarted: number;
  active: number;
  done: number;
}) {
  const total = notStarted + active + done;

  return (
    <div className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3">
      <span className="min-w-0 truncate text-xs font-medium" title={label}>
        {label}
      </span>

      {total === 0 ? (
        <span className="text-2xs text-muted-foreground">No tasks in this period</span>
      ) : (
        // gap-0.5 is the 2px surface gap between adjacent fills. Without it two
        // segments of similar lightness read as one bar.
        <div className="flex h-2.5 min-w-0 gap-0.5 overflow-hidden rounded-full">
          {(
            [
              ["chart-1", notStarted],
              ["chart-2", active],
              ["chart-3", done],
            ] as const
          ).map(([tone, count], index) =>
            count === 0 ? null : (
              <div
                key={tone}
                className={cn(
                  TONE[tone],
                  "h-full",
                  index === 0 && "rounded-l-full",
                  // Rounded on whichever segment is last, so the bar's end is
                  // its end regardless of which stages are empty.
                  "last:rounded-r-full",
                )}
                style={{ width: `${(count / total) * 100}%` }}
              />
            ),
          )}
        </div>
      )}

      <span className="shrink-0 text-xs font-medium tabular-nums">{total}</span>
    </div>
  );
}

/**
 * The legend, always present for two or more series.
 *
 * A swatch AND a word, never a swatch alone — and the counts sit on it, so the
 * legend is doing work rather than only explaining the colours.
 */
export function StageLegend({
  notStarted,
  active,
  done,
}: {
  notStarted: number;
  active: number;
  done: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {(
        [
          ["chart-1", "Not started", notStarted],
          ["chart-2", "Active", active],
          ["chart-3", "Done", done],
        ] as const
      ).map(([tone, label, count]) => (
        <span key={label} className="inline-flex items-center gap-1.5 text-2xs">
          <span className={cn("size-2.5 shrink-0 rounded-sm", TONE[tone])} aria-hidden />
          <span className="text-muted-foreground">{label}</span>
          <span className="font-semibold tabular-nums">{count}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The categorical slots, ASSIGNED IN FIXED ORDER and never cycled.
 *
 * These are `--chart-1..3` from `app/globals.css`, which were re-stepped on
 * 19 Aug 2026 because the previous five failed four of the validator's five
 * checks — including the hard normal-vision floor. See the comment on the tokens.
 */
const TONE = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
} as const;

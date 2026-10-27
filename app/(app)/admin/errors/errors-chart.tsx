/**
 * P17-05 — how many errors, over time. Plain HTML, like the reports page's
 * charts: one series, so no legend (the heading names it), a column per day —
 * or per hour on the 24-hour view — rendered on the server with no script.
 *
 * Empty buckets are drawn as a hairline rather than dropped: a quiet day is the
 * good news, and leaving it out would draw a quiet week as a short one.
 *
 * Each column carries its value as a `title` (the hover layer) and the whole
 * series is repeated as a visually hidden list, so nothing here is readable by
 * bar height alone. The table under the chart is the full record.
 */
export function ErrorsChart({
  buckets,
  heading,
}: {
  buckets: { label: string; count: number }[];
  heading: string;
}) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const peak = buckets.reduce((best, bucket) => (bucket.count > best.count ? bucket : best), buckets[0]);
  // First, middle and last under the axis — every label on 30 columns collides.
  const ticks = new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]);

  return (
    <section
      aria-label={heading}
      className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 shadow-raised-lg grade-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{total}</span> {total === 1 ? "error" : "errors"}
          {total > 0 && peak ? (
            <>
              {" "}
              · most on <span className="text-foreground">{peak.label}</span> (
              <span className="tabular-nums">{peak.count}</span>)
            </>
          ) : null}
        </p>
      </div>

      <div aria-hidden className="flex h-16 items-end gap-0.5 border-b">
        {buckets.map((bucket) => (
          <div
            className="group relative flex h-full flex-1 items-end"
            key={bucket.label}
            title={`${bucket.label}: ${bucket.count} ${bucket.count === 1 ? "error" : "errors"}`}
          >
            {bucket.count > 0 ? (
              <div
                className="w-full rounded-t-sm bg-chart-1 transition-opacity group-hover:opacity-80"
                style={{ height: `${Math.max(4, (bucket.count / max) * 100)}%` }}
              />
            ) : (
              <div className="h-px w-full bg-border" />
            )}
          </div>
        ))}
      </div>

      <div aria-hidden className="flex gap-0.5 text-2xs text-muted-foreground">
        {buckets.map((bucket, index) => (
          <span
            className={
              index === 0 ? "flex-1 text-left" : index === buckets.length - 1 ? "flex-1 text-right" : "flex-1 text-center"
            }
            key={bucket.label}
          >
            {ticks.has(index) ? bucket.label : ""}
          </span>
        ))}
      </div>

      <ul className="sr-only">
        {buckets.map((bucket) => (
          <li key={bucket.label}>
            {bucket.label}: {bucket.count} {bucket.count === 1 ? "error" : "errors"}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The same bug, counted once — the answer to "what should I fix first", which
 * the newest-first table below cannot give.
 */
export function TopErrors({ groups }: { groups: { message: string; where: string; count: number }[] }) {
  if (groups.length === 0) return null;
  return (
    <section aria-label="Most frequent" className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 shadow-raised-lg grade-surface">
      <h2 className="text-sm font-semibold">Most frequent</h2>
      <ol className="flex flex-col divide-y">
        {groups.map((group) => (
          <li className="flex items-start gap-3 py-2" key={`${group.where}${group.message}`}>
            <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">×{group.count}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm" title={group.message}>
                {group.message}
              </span>
              <span className="block truncate font-mono text-2xs text-muted-foreground" title={group.where}>
                {group.where}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

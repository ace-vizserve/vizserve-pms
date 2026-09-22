"use client";

import * as React from "react";
import { AlertTriangle, ScrollText, Search, X } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatMonthYear } from "@/lib/dates";
import {
  CHANGELOG_KIND_LABELS,
  type ChangelogEntry,
  type ChangelogKind,
} from "@/lib/schemas/changelog";

/**
 * The changelog, as a timeline of raised cards grouped by month.
 *
 * ⚠️ THIS IS THE FOURTH LAYOUT. The three it replaces are recorded in
 * `page.tsx` — read them before "improving" this one, because two of them were
 * already rejected on sight. What changed here, and why:
 *
 *   · **Each entry is an object now.** It was a bare `<article>` separated from
 *     the next by `space-y-16`, which at 29 entries reads as one wall of text
 *     with gaps in it. §1.5 is explicit that a thing you act on is raised and
 *     everything else is flat — and `--background` is a cool grey precisely so
 *     a card has something to sit on. So: `bg-card grade-surface` with
 *     `shadow-raised-lg`, the treatment every other panel in the app gets.
 *   · **There is a spine.** A month heading, a continuous rule, and a dot per
 *     entry. A changelog's one job is chronology, and the old version expressed
 *     it only through the order of the entries.
 *   · **The 192px date rail is gone.** Two badges and a date did not fit it —
 *     they wrapped to three lines at every breakpoint below `lg`. The same
 *     three things now sit on one row inside the card, where there is width for
 *     them, and the rail's job (saying when) belongs to the month heading and
 *     the dot.
 *
 * ⚠️ CLIENT-SIDE FILTERING ON PURPOSE, AND THE ALTERNATIVE WAS WORSE. The usual
 * shape for filters in this app is `searchParams` — shareable, server-rendered,
 * what `/tasks` does. It is wrong here:
 *
 *   · `cacheComponents` is on. Reading `searchParams` opts the route out of its
 *     prerendered shell, so a page whose entire content is 29 static JSON files
 *     would start running per request to answer "does this title contain
 *     'leave'".
 *   · The whole list is ~60 entries a year and already in the payload. A round
 *     trip per keystroke to filter what the browser is already holding is
 *     latency with nothing bought.
 *
 * Nothing in this file fetches. The entries arrive sorted newest-first from
 * `lib/changelog.ts` and every operation below preserves that order.
 */

/** `all` is a filter value, not an absence — a segmented control always has one chosen. */
type KindFilter = ChangelogKind | "all";

/**
 * `kind` → an existing `Badge` variant.
 *
 * ⚠️ VARIANTS, NOT COLOURS. §7 forbids a hand-rolled status pill at a call
 * site, and §4.1 keeps every status→tone map inside `status-badge.tsx`. A
 * changelog `kind` is not a status — nothing transitions between these, they
 * describe a past event — so it does not belong in that file either. Reaching
 * for `Badge` variants that already exist is how to differentiate without
 * starting a second tone map that drifts from the first.
 *
 * `removed` is `destructive` because it is the one kind that means something is
 * gone; the rest descend in emphasis. Every badge renders its WORD, so this
 * survives greyscale (§5.5) — the variant is emphasis, not the message.
 */
const KIND_VARIANT: Record<ChangelogKind, "accent" | "secondary" | "outline" | "destructive"> = {
  added: "accent",
  changed: "secondary",
  fixed: "outline",
  removed: "destructive",
};

export function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [area, setArea] = React.useState("all");
  const [year, setYear] = React.useState("all");

  /*
   * Derived from the entries, not from the schema's unions. The schema lists
   * every area the app COULD ship in; these dropdowns should only offer the
   * ones something has actually landed in, or a third of the options match
   * nothing and the control lies about what is there.
   */
  const areas = React.useMemo(
    () => [...new Set(entries.map((entry) => entry.area))].sort(),
    [entries],
  );
  const years = React.useMemo(
    () => [...new Set(entries.map((entry) => entry.date.slice(0, 4)))].sort().reverse(),
    [entries],
  );

  /*
   * The value → label maps the `Select` root needs. Area and year labels happen
   * to equal their values, and the map is still mandatory —
   * `scripts/check-select-items.mjs` fails the build without it, because Base
   * UI's `SelectValue` prints the root's raw value and the closed trigger would
   * otherwise read "all". The guard is absolute precisely because "harmless,
   * the two match" is a property that stops holding quietly.
   */
  const areaItems = React.useMemo<Record<string, string>>(
    () => ({ all: "All areas", ...Object.fromEntries(areas.map((a) => [a, a])) }),
    [areas],
  );
  const yearItems = React.useMemo<Record<string, string>>(
    () => ({ all: "All years", ...Object.fromEntries(years.map((y) => [y, y])) }),
    [years],
  );

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();

    return entries.filter((entry) => {
      if (kind !== "all" && entry.kind !== kind) return false;
      if (area !== "all" && entry.area !== area) return false;
      if (year !== "all" && !entry.date.startsWith(year)) return false;
      if (!needle) return true;

      // Title, description, items AND refs — so pasting "P8-19" out of a commit
      // message finds its entry, which is how anybody holding a git log looks.
      return [entry.title, entry.description, ...(entry.items ?? []), ...(entry.refs ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [entries, query, kind, area, year]);

  /*
   * Grouped by calendar month, in the order the entries already have. A `Map`
   * preserves insertion order, so newest-first in gives newest-first out
   * without a second sort — and the key is `YYYY-MM` rather than a formatted
   * label, because grouping on a display string makes the grouping depend on
   * the locale.
   */
  const months = React.useMemo(() => {
    const grouped = new Map<string, ChangelogEntry[]>();
    for (const entry of filtered) {
      const key = entry.date.slice(0, 7);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(entry);
      else grouped.set(key, [entry]);
    }
    return [...grouped];
  }, [filtered]);

  const isFiltered = query.trim() !== "" || kind !== "all" || area !== "all" || year !== "all";

  /*
   * Base UI's Select emits `string | null` — null when a value is cleared — and
   * these filters have no empty state: "all" IS unfiltered. The fallback keeps
   * that a total function rather than a cast.
   */
  const setNullable = (set: (value: string) => void) => (value: string | null) =>
    set(value ?? "all");

  const clear = () => {
    setQuery("");
    setKind("all");
    setArea("all");
    setYear("all");
  };

  return (
    <>
      {/*
        The filter bar, frosted and stuck under the top bar.

        `top-[4.5rem]` is the 56px bar plus a gutter — the same offset the old
        date rail used, so it is a proven value on this page rather than a
        guess. `bg-panel` + `backdrop-blur-md` + `shadow-chrome` is the chrome
        recipe from §1.6; a solid fill here would read as a second page header
        scrolling over the first.
      */}
      <div className="sticky top-[4.5rem] z-20 mt-4 rounded-lg border bg-panel px-3 py-2.5 shadow-chrome backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-full sm:w-56">
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search the changelog"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              type="search"
              value={query}
            />
          </InputGroup>

          {/* Kind is the axis people scan by, so it gets the visible control
              rather than a dropdown: four options fit, and a segmented control
              shows what the choices ARE without a click. */}
          <Segmented<KindFilter> onValueChange={setKind} value={kind}>
            <SegmentedItem className="px-2.5 py-1" value="all">
              All
            </SegmentedItem>
            {(Object.keys(CHANGELOG_KIND_LABELS) as ChangelogKind[]).map((value) => (
              <SegmentedItem className="px-2.5 py-1" key={value} value={value}>
                {CHANGELOG_KIND_LABELS[value]}
              </SegmentedItem>
            ))}
          </Segmented>

          <Select items={areaItems} onValueChange={setNullable(setArea)} value={area}>
            <SelectTrigger aria-label="Filter by area" className="w-32" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {areas.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select items={yearItems} onValueChange={setNullable(setYear)} value={year}>
            <SelectTrigger aria-label="Filter by year" className="w-28" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All years</SelectItem>
              {years.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* The count sits in the bar rather than under it, so it stays
              visible alongside the controls that caused it. `aria-live`
              because it IS live — it is the only thing that reports what a
              keystroke in the search box did. */}
          <p aria-live="polite" className="ml-auto text-2xs tabular-nums text-muted-foreground">
            {filtered.length === entries.length
              ? `${entries.length} entries`
              : `${filtered.length} of ${entries.length}`}
          </p>

          {isFiltered ? (
            <Button onClick={clear} size="xs" variant="ghost">
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {months.length === 0 ? (
        <EmptyState
          action={
            <Button onClick={clear} size="sm" variant="outline">
              Clear filters
            </Button>
          }
          description="Nothing shipped under that search in the months you have selected. Widen the filters, or search a backlog ID like P8-19."
          icon={<ScrollText />}
          title="No entries match"
        />
      ) : (
        <div className="mt-8 space-y-10">
          {months.map(([month, monthEntries]) => (
            <section key={month}>
              {/* The month heading. `formatMonthYear` takes a bare date, so the
                  key gets a day appended — it is only ever formatted, never
                  read back. */}
              <div className="mb-3 flex items-center gap-3">
                <h2 className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  {formatMonthYear(`${month}-01`)}
                </h2>
                <span aria-hidden className="h-px flex-1 bg-border" />
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {monthEntries.length}
                </span>
              </div>

              {/*
                The spine. One continuous rule per month, carried by this
                container's own left border, with a dot per entry sitting over
                it.

                ⚠️ THE DOT IS DECORATION AND CARRIES NO MEANING. It is
                `aria-hidden`, it does not encode `kind`, and it is doing a
                non-text job with `--border-strong` — which is exactly what the
                faint end of the scale is reserved for (§1.1). The kind is on
                the badge, in words.
              */}
              <div className="ml-[5px] space-y-4 border-l border-border pl-6 md:pl-8">
                {monthEntries.map((entry) => (
                  <article
                    className="relative rounded-lg border bg-card grade-surface p-5 shadow-raised-lg"
                    key={`${entry.date}-${entry.title}`}
                  >
                    <span
                      aria-hidden
                      className="absolute top-6 -left-[30px] size-2.5 rounded-full border-2 border-background bg-border-strong md:-left-[38px]"
                    />

                    {/* Kind, area, date — one row, where there is width for
                        them. `flex-wrap` so a phone gets two lines rather than
                        a squeeze. */}
                    <div className="mb-2.5 flex flex-wrap items-center gap-2">
                      <Badge variant={KIND_VARIANT[entry.kind]}>
                        {CHANGELOG_KIND_LABELS[entry.kind]}
                      </Badge>
                      <Badge variant="secondary">{entry.area}</Badge>
                      {/* `formatDate` rather than a local format: it parses the
                          bare date as midday UTC, which is what stops "21 Sep"
                          rendering as the 20th for anybody west of UTC. */}
                      <time
                        className="text-2xs font-medium tabular-nums text-muted-foreground"
                        dateTime={entry.date}
                      >
                        {formatDate(entry.date)}
                      </time>
                    </div>

                    {/* The measure lives on the prose, not on the card — the
                        card spans the column and the paragraph stops at 72ch,
                        which is where prose stops being comfortable to read. */}
                    <h3 className="mb-1.5 max-w-[68ch] text-lg leading-tight font-semibold tracking-[-0.018em]">
                      {entry.title}
                    </h3>
                    <p className="max-w-[72ch] text-sm text-foreground-muted">
                      {entry.description}
                    </p>

                    {entry.items && entry.items.length > 0 ? (
                      <ul className="mt-3 ml-4 max-w-[72ch] space-y-1.5 text-sm text-muted-foreground">
                        {entry.items.map((item) => (
                          <li className="list-disc" key={item}>
                            {item}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {/*
                      The caveat, when the status doc records one. A real
                      warning tone rather than muted text: an entry that says a
                      feature landed, when its migration has not been applied,
                      sends somebody looking for a screen that errors.

                      `AlertTriangle` is `aria-hidden` and the sentence carries
                      the meaning, so this survives greyscale — the tone is not
                      the message.
                    */}
                    {entry.pending ? (
                      <p className="mt-3 flex max-w-[72ch] items-start gap-1.5 rounded-md border border-warning-border bg-warning-subtle px-2.5 py-1.5 text-2xs text-warning">
                        <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
                        <span>{entry.pending}</span>
                      </p>
                    ) : null}

                    {/* `--foreground-faint` is 3.44:1 and NON-TEXT ONLY, so it
                        is not here at all — every word in this row is
                        `--muted-foreground` (5.06:1). Setting faint on the row
                        and overriding it on each child works until somebody
                        adds a fourth child. */}
                    {entry.refs && entry.refs.length > 0 ? (
                      <p className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t pt-3 text-2xs text-muted-foreground">
                        <span>Backlog</span>
                        {entry.refs.map((ref) => (
                          <span
                            className="rounded-sm border border-border px-1.5 py-0.5 font-mono"
                            key={ref}
                          >
                            {ref}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";

import { PageHeader, PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { CHANGELOG } from "@/lib/changelog";
import { formatDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Changelog" };

/**
 * What shipped, newest first.
 *
 * Adapted from a shadcnblocks marketing block, and the adaptation is most of
 * the work — the original is a landing-page section and this is a page inside
 * the shell:
 *
 *   · `py-32` and `container` became `PageShell`, which is full width with its
 *     own padding. A marketing rhythm inside the app reads as a different
 *     product.
 *   · `text-3xl md:text-5xl` became `PageHeader`. Per §1.3 the 3xl-and-up sizes
 *     are "marketing and auth surfaces only"; `text-xl` is a page heading here.
 *   · `<Button variant="link" asChild><a/></Button>` is gone entirely. `asChild`
 *     is Radix and these primitives are Base UI, and dressing a link as a
 *     Button is ruled out in as many words (§2.1) — the refs render as plain
 *     text because they point at a backlog, not at a page.
 *   · The `<img>` slot is gone. There are no assets to put in it, and inventing
 *     a placeholder CDN URL would ship a broken image.
 *
 * A server component with no queries: the content is a TypeScript module, so
 * there is nothing to await and no `loading.tsx` to hold a place for.
 */
export default function ChangelogPage() {
  /*
   * CENTRED, AT `max-w-5xl` — and this is the third layout, so the two it
   * replaces are worth recording rather than rediscovering.
   *
   *   1. `mx-auto max-w-4xl`. Centred but narrow: a margin on both sides while
   *      the top bar still ran to the sidebar edge, which is the void §1.6
   *      describes. Reported as "so many empty space".
   *   2. Full width, left-aligned, with the measure on the prose. That is what
   *      §1.6 prescribes and what every list screen here does — and it was
   *      rejected on sight: a 72ch column pinned to the left of a wide monitor
   *      reads as an unfinished page, not a deliberate one.
   *
   * So: centred, but a size up from the first attempt. `5xl` is 1024px against
   * the old 896, and the rail and gutter now sit INSIDE it (192 + 48), leaving
   * the prose ~784px — close enough to its own 72ch cap that the column looks
   * filled rather than floated.
   *
   * ⚠️ This is a deliberate exception to §1.6's full-width rule, chosen by the
   * person who has to look at it. Do not "fix" it back without asking them.
   */
  return (
    <PageShell className="mx-auto w-full max-w-5xl">
      <PageHeader
        description="What shipped, newest first. Deployed continuously, so these are dates rather than versions."
        title="Changelog"
      />

      <div className="mt-6 space-y-12 md:space-y-16">
        {CHANGELOG.map((entry) => (
          <article
            className="relative flex flex-col gap-4 md:flex-row md:gap-10"
            key={`${entry.date}-${entry.title}`}
          >
            {/*
              The date rail. Sticky on wide screens so the date stays beside a
              long entry — offset by the 56px top bar plus a gutter, or it
              would pin itself underneath the frosted header.
            */}
            <div className="flex h-min w-full shrink-0 items-center gap-3 md:sticky md:top-[4.5rem] md:w-48">
              <Badge variant="secondary">{entry.area}</Badge>
              {/* `formatDate` rather than a local format: it parses the bare
                  date as midday UTC, which is what stops "21 Sep" rendering as
                  the 20th for anybody west of UTC. */}
              <time className="text-2xs font-medium text-muted-foreground" dateTime={entry.date}>
                {formatDate(entry.date)}
              </time>
            </div>

            {/* The measure lives here, not on the page. `72ch` is roughly the
                width prose stops being comfortable at; the rail and the gap sit
                outside it, so on a wide screen the entry starts at the sidebar
                edge instead of floating. */}
            <div className="flex min-w-0 max-w-[72ch] flex-col">
              <h2 className="mb-2 text-lg font-semibold leading-tight tracking-[-0.018em]">
                {entry.title}
              </h2>
              <p className="text-sm text-foreground-muted">{entry.description}</p>

              {entry.items && entry.items.length > 0 ? (
                <ul className="mt-3 ml-4 space-y-1.5 text-sm text-muted-foreground">
                  {entry.items.map((item) => (
                    <li className="list-disc" key={item}>
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/*
                  The caveat, when the status doc records one. It is a real
                  warning tone rather than muted text: an entry that says a
                  feature landed, when its migration has not been applied, sends
                  somebody looking for a screen that errors.

                  `AlertTriangle` is `aria-hidden` and the sentence carries the
                  meaning, so this survives greyscale — the tone is not the
                  message.
              */}
              {entry.pending ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-subtle px-2.5 py-1.5 text-2xs text-warning">
                  <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
                  <span>{entry.pending}</span>
                </p>
              ) : null}

              {/* `--foreground-faint` is 3.44:1 and NON-TEXT ONLY, so it is not
                  here at all — every word in this row is `--muted-foreground`
                  (5.06:1). Setting faint on the row and overriding it on each
                  child works until somebody adds a fourth child. */}
              {entry.refs && entry.refs.length > 0 ? (
                <p className="mt-3 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
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
            </div>
          </article>
        ))}
      </div>
    </PageShell>
  );
}

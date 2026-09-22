import type { Metadata } from "next";

import { PageHeader, PageShell } from "@/components/page-shell";
import { CHANGELOG } from "@/lib/changelog";

import { ChangelogList } from "./changelog-list";

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
 * A server component with no queries: the entries are 29 JSON files read off
 * disk at build (`lib/changelog.ts`), so there is nothing to await and no
 * `loading.tsx` to hold a place for.
 *
 * ⚠️ THE ENTRIES ARE READ HERE AND THE LIST IS RENDERED BY A CLIENT COMPONENT,
 * and the seam is deliberate. `lib/changelog.ts` is `server-only` because it
 * touches `node:fs`; the filter needs state. So the whole array crosses once,
 * in the RSC payload, and every keystroke after that is local — the route stays
 * statically prerendered, which reading `searchParams` under `cacheComponents`
 * would have given up.
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

      <ChangelogList entries={CHANGELOG} />
    </PageShell>
  );
}

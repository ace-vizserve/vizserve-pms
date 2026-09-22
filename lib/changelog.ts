import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { changelogEntrySchema, type ChangelogEntry } from "@/lib/schemas/changelog";

/**
 * What shipped, newest first — the source for `/changelog`.
 *
 * ⚠️ ONE JSON FILE PER ENTRY, under `content/changelog/`. This was a single
 * TypeScript array of 29 entries until 22 Sep 2026, and the move is about
 * *authoring*, not rendering:
 *
 *   · Every entry is appended to the TOP, so two people adding one in the same
 *     week conflicted on the same three lines every time. Separate files cannot
 *     conflict with each other at all.
 *   · An entry becomes one whole-file diff — added, revised or deleted — which
 *     is reviewable on its own instead of as a hunk in a 400-line module.
 *   · `scripts/changelog-gap.mjs` and the `changelog` skill read the directory
 *     instead of regexing TypeScript for `date:`.
 *
 * ONE FILE PER ENTRY, NOT PER DAY AND NOT PER MONTH. Two features shipping on
 * the same date is the normal case here — 21 Sep has three — so a per-day file
 * is exactly the shared file whose conflicts this was meant to end. A
 * year/month directory would also put the date in the PATH as well as the
 * payload, and two copies of one date drift the first time somebody copies a
 * file to start a new entry.
 *
 * Filtering played no part in the layout, because it cannot: 29 entries (~60 a
 * year) all load either way and the filter runs over the array in the browser.
 * File layout is an authoring question only.
 *
 * ⚠️ NO VERSION NUMBERS, DELIBERATELY. This app has no release train: it is
 * deployed continuously, `package.json` has sat at `0.1.0` since the scaffold,
 * and nothing tags a build. Printing "v1.3.0" beside a date would invent a
 * scheme the repo does not have and that nobody could reconcile with a commit.
 * What it DOES have is dates and backlog IDs, so those are what an entry
 * carries — `refs` are the same IDs the commits use (`P7-73`), which is the
 * thread back to the work.
 *
 * ⚠️ HAND-WRITTEN, AND THAT IS THE POINT. A changelog generated from commit
 * subjects is a commit log with worse formatting; this is the short list of
 * things a colleague would notice, written for them. `npm run changelog:check`
 * finds the commits nothing covers and stops there — the prose is a judgement
 * call. See `.claude/skills/changelog/`.
 *
 * ⚠️ THE TYPE GUARANTEE MOVED TO ZOD. JSON cannot be checked by `tsc`, so
 * `lib/schemas/changelog.ts` is the contract and every file is parsed through
 * it here. A misspelt `area` throws at load — during the build, or in
 * `tests/unit/changelog.test.ts` — rather than rendering an unstyled badge.
 *
 * `server-only` because this reads the filesystem. The page is a server
 * component and hands the parsed array to the client filter, so nothing in the
 * browser bundle imports this module.
 *
 * The history back to 29 Jul 2026 was reconstructed from
 * `docs/13-implementation-status.md` and `git log`, phase by phase. That
 * document is the record of what is actually built and stays the authority — if
 * the two ever disagree, it wins and this file is wrong.
 */

export type { ChangelogEntry } from "@/lib/schemas/changelog";

/**
 * Where the entries live. `process.cwd()` is the repo root for `next build`,
 * `next start` and vitest alike.
 */
const CONTENT_DIR = join(process.cwd(), "content", "changelog");

/**
 * Read, parse and sort — once per process, at module load.
 *
 * ⚠️ `readdirSync` IS NOT STATICALLY ANALYSABLE, so Next's output tracing
 * cannot see these files. `outputFileTracingIncludes` in `next.config.ts` names
 * them explicitly; without it the page prerenders fine locally and throws
 * ENOENT on Vercel.
 *
 * Sorted here rather than trusted from the directory listing. Filenames start
 * with a date so `readdirSync` is *almost* right — but the filename is not
 * authoritative (see the schema), and two entries sharing a date need a stable
 * tiebreak. Date descending, then title, so the order never depends on how the
 * filesystem felt that morning.
 */
function loadChangelog(): ChangelogEntry[] {
  const entries = readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const raw: unknown = JSON.parse(readFileSync(join(CONTENT_DIR, name), "utf8"));
      const parsed = changelogEntrySchema.safeParse(raw);
      if (!parsed.success) {
        // Name the file. A bare zod message sends you looking through 29 of them.
        throw new Error(`content/changelog/${name} is not a valid entry:\n${parsed.error.message}`);
      }
      return parsed.data;
    });

  return entries.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}

export const CHANGELOG: ChangelogEntry[] = loadChangelog();

/**
 * The filenames, so the test can assert each one starts with its entry's own
 * `date`. Exported for that reason alone — nothing renders it.
 */
export function changelogFilenames(): string[] {
  return readdirSync(CONTENT_DIR).filter((name) => name.endsWith(".json"));
}

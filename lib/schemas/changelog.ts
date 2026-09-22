import { z } from "zod";

/**
 * What an entry on `/changelog` is.
 *
 * ⚠️ THIS SCHEMA IS THE TYPE CHECKER FOR CONTENT THAT LIVES IN JSON. The
 * entries used to be a TypeScript array, where `tsc` caught a misspelt `area`
 * and a missing `title` for free. They are now one JSON file each under
 * `content/changelog/`, which buys atomic diffs and loses every compile-time
 * guarantee — so the guarantee moves here, and `lib/changelog.ts` parses every
 * file through it at load. A malformed entry fails the build and the unit test,
 * not the page.
 *
 * The same reason the rest of `lib/schemas/` exists (D3a, R11): the contract is
 * written down once and both sides read it.
 */

/**
 * WHAT SORT OF CHANGE IT WAS — the axis the entries carried only in how their
 * titles happened to be worded.
 *
 * Four, matching Keep a Changelog's useful subset. A REPLACEMENT is `changed`
 * when the job moved somewhere else (EmailJS → Resend) and `removed` only when
 * the capability is gone with nothing behind it, because an entry that says
 * "removed" about a thing that still works reads as a loss.
 *
 * Deliberately NOT a fifth `security` or `deprecated`: nothing here has shipped
 * either, and a filter option that never matches is worse than one less option.
 */
export const CHANGELOG_KINDS = ["added", "changed", "fixed", "removed"] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

/** How each kind is labelled on screen. The filter and the badge share it. */
export const CHANGELOG_KIND_LABELS: Record<ChangelogKind, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  removed: "Removed",
};

/**
 * WHERE it landed. The six modules, plus `Platform` for anything cross-cutting
 * and `Reporting` which is its own surface rather than a module.
 */
export const CHANGELOG_AREAS = [
  "Tasks",
  "Timesheet",
  "Leave",
  "DTR",
  "Forms",
  "Approvals",
  "Reporting",
  "Platform",
] as const;
export type ChangelogArea = (typeof CHANGELOG_AREAS)[number];

export const changelogEntrySchema = z.object({
  /**
   * Bare `YYYY-MM-DD`, and the SINGLE source of truth for when this shipped.
   *
   * ⚠️ THE FILENAME ALSO STARTS WITH A DATE, AND IT IS NOT AUTHORITATIVE. A
   * date in two places drifts the first time somebody copies a file to start a
   * new entry; the loader reads this field and `tests/unit/changelog.test.ts`
   * asserts the two agree, so the drift is caught rather than rendered.
   *
   * Formatted at render through `lib/dates.ts`, never here — it parses as
   * midday UTC so the day cannot slip backwards in a negative offset.
   */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be a bare YYYY-MM-DD"),
  kind: z.enum(CHANGELOG_KINDS),
  area: z.enum(CHANGELOG_AREAS),
  /** One line, sentence case. No ticket number — those go in `refs`. */
  title: z.string().min(1),
  /** One or two sentences: what changed, and why anybody would care. */
  description: z.string().min(1),
  /** The specifics. Short enough to scan. */
  items: z.array(z.string().min(1)).optional(),
  /** Backlog IDs, as the commits carry them (`P8-18`). */
  refs: z.array(z.string().min(1)).optional(),
  /**
   * A caveat, rendered as a warning line under the entry.
   *
   * ⚠️ THIS FIELD EXISTS SO THE CHANGELOG CANNOT LIE. Several features are
   * code-complete with a migration that has not been applied to the live
   * project — `docs/13-implementation-status.md` names each one. Announcing
   * those as shipped sends somebody to a screen that errors.
   */
  pending: z.string().min(1).optional(),
});

export type ChangelogEntry = z.infer<typeof changelogEntrySchema>;

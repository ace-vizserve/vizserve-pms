---
name: changelog
description: Keep /changelog current. Use after shipping, changing or removing anything a colleague would notice — a feature, a screen, a permission, a rule — and whenever the user asks to update the changelog, or a hook reports commits the changelog does not cover. Writes one JSON entry under content/changelog/.
---

# Changelog

**One entry is one JSON file under `content/changelog/`.** Adding a file is the
whole job — there is no CMS, no table, and neither the page nor the loader needs
touching to pick a new entry up.

- `content/changelog/<YYYY-MM-DD>-<slug>.json` — the entries, one each
- `lib/schemas/changelog.ts` — the zod contract. **This is the type checker**,
  because JSON gets none from `tsc`
- `lib/changelog.ts` — reads the directory, parses every file through the
  schema, sorts newest-first. Throws and names the file if one is malformed
- `app/(app)/changelog/changelog-list.tsx` — the client component that filters
- `app/(app)/changelog/page.tsx` — the shell. You will not need to edit it

## Read this before writing a word

`lib/changelog.ts` opens with the warnings that govern this skill:

- **No version numbers.** Nothing tags a build, `package.json` has sat at
  `0.1.0` since the scaffold, and a printed `v1.3.0` would invent a scheme
  nobody could reconcile with a commit. Entries carry a **date** and **backlog
  IDs**.
- **Hand-written, and that is the point.** "A changelog generated from commit
  subjects is a commit log with worse formatting." The entry is the short list
  of things *a colleague would notice*, written for them. `scripts/changelog-gap.mjs`
  finds candidate commits; it never writes prose, and neither should a paste of
  `git log`.
- **One file per entry, never per day.** Two features shipping on one date is
  normal here. Do not merge a new entry into an existing file because the dates
  match.

And `docs/13-implementation-status.md` is the authority on what is actually
built. If it and the changelog disagree, **the doc wins and the changelog is
wrong.**

## Steps

1. **Find what is uncovered.**

   ```bash
   npm run changelog:check          # commits since the newest entry, with a guessed area
   ```

   It filters by backlog ID, by date and by subject shape, so what it prints is
   a shortlist, not a verdict. Half the commit subjects on this branch are
   "feat adding gantt chart" or "merging", so expect both false positives
   (already written up under an entry whose `refs` the commit never named) and
   silence where a subject said `chore:` but the diff shipped a screen.

2. **Read the diffs, not the subjects.** For each candidate:
   `git show --stat <sha>`, then look at what a user touches — a route under
   `app/(app)/`, a component, a server action's rules, a migration that adds a
   column somebody fills in. A refactor with an identical screen is not an
   entry.

3. **Decide its `kind`** — see the table under "The entry". `feat(...)` is
   usually `added` and `fix(...)` usually `fixed`, but read the diff: "rebuilt
   as a week grid" is `changed`, and "a shared list is now actually shared" is
   `fixed` however the subject was worded.

4. **Group by what shipped, not by commit.** Five commits fixing one feature
   are one entry. One commit touching the timesheet and the DTR is two.

5. **Check `docs/13-implementation-status.md` for an unapplied migration.** If
   the feature's migration is written but not pasted into the live project, the
   entry **must** carry a `pending` line saying so. That field exists so the
   changelog cannot lie: announcing an unapplied feature sends somebody to a
   screen that errors. See the P13-02 entry for the wording.

6. **Write the file.** `content/changelog/<date>-<slug>.json`, the slug being
   the title in kebab-case, truncated at a whole word to about 50 characters.
   Nothing sorts by filename — the loader sorts on the `date` field — so the
   name only has to be unique and readable.

7. **Verify.** JSON gets no help from `tsc`, so the schema and the test are the
   only gates:
   ```bash
   npm run test -- tests/unit/changelog.test.ts
   npm run typecheck
   ```
   The test's import is itself the assertion: a misspelt `area` or `kind`, a
   malformed date, a filename whose date disagrees with the payload, or an
   out-of-order list all fail there.

## The entry

```json
{
  "date": "2026-09-22",
  "kind": "added",
  "area": "Tasks",
  "title": "One line, sentence case, no ticket number and no \"feat:\"",
  "description": "One or two sentences: what changed, and why anybody cares.",
  "items": ["The specifics, short enough to scan"],
  "refs": ["P8-18"],
  "pending": "Only when the migration is not applied — renders as a warning line"
}
```

`date` is bare `YYYY-MM-DD`, formatted at render by `lib/dates.ts`. `items`,
`refs` and `pending` are optional — **omit the key** rather than writing `[]` or
`""`, which the schema rejects. Key order above is the house order; keep it.

`kind` — the axis the filter uses, and the one people scan for:

| `kind` | When |
|---|---|
| `added` | a new capability, phrased as the thing you can now do |
| `changed` | the old behaviour named, then the new one. Also a **replacement**, when the job moved somewhere else |
| `fixed` | it was broken or it lied, and now it does not |
| `removed` | the capability is gone with nothing behind it. Say where its job went, or it reads as a loss |

`area` — one of `Tasks`, `Timesheet`, `Leave`, `DTR`, `Forms`, `Approvals`,
`Reporting`, `Platform`. Both unions live in `lib/schemas/changelog.ts`; adding
a value there is a decision, not a convenience.

Use the date the work **shipped**, not the date you write the entry. Two
entries may share a date — that is the normal case, and each gets its own file.

## Voice

Match the entries already there — they are the specification, and they read like
a colleague explaining the change, not like release notes.

- **Say what you can now do, not what was implemented.** "One space every
  department shares", not "added `is_company_wide` to the tasks table."
- **No identifiers in prose.** No table names, no column names, no component
  names, no `vizserve_pms_` anything. Those go in `refs`.
- **The product is "VizServe Team Portal".** Never "PMS" in a string a user
  reads — the rename on 7 Sep was the product only. `refs` and paths keep the
  old name; sentences do not.
- **Roles by their names in the UI**: member, team leader, manager, admin.
- **No marketing.** Nothing is "seamless", "powerful" or "revamped". The
  existing entries are flat and specific; stay there.
- **Skip what nobody can see**: refactors, dependency bumps, test coverage,
  CI, migrations renumbered, docs. The gap detector already drops most of
  these; drop the rest yourself.

## Do not

- Do not reword or re-date an existing entry to fold new work into it, unless
  the work is genuinely the same shipment. Sharing a date is not sharing a
  shipment — write a second file.
- Do not add a `date` to the filename and a different one to the payload. The
  payload wins, and the test fails on the disagreement.
- Do not delete history. An entry about something later removed stays — the
  removal is a new file with `"kind": "removed"`.
- Do not touch `app/(app)/changelog/page.tsx`. Its centred `max-w-5xl` layout
  is a deliberate exception to the full-width rule, chosen by the person who
  looks at it, and the comment in the file says not to "fix" it back. Content
  changes never need it.
- Do not claim a feature is live when its migration is not applied. Use
  `pending`.

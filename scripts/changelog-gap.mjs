/**
 * Does the changelog owe an entry?
 *
 * ⚠️ THIS SCRIPT DOES NOT WRITE THE CHANGELOG, AND MUST NOT LEARN TO.
 * `lib/changelog.ts` says in as many words that it is hand-maintained and that
 * a changelog generated from commit subjects is a commit log with worse
 * formatting. This is the *detector*: it answers "has something user-facing
 * landed that no entry covers", names the commits, and stops. The prose is a
 * judgement call and belongs to the `changelog` skill (or to a person).
 *
 * How the gap is found, in order of how much it trusts the input:
 *
 *   1. Backlog IDs. Commits here carry them (`feat(P8-18): …`) and entries
 *      carry the same ones in `refs`. A commit whose every ID already appears
 *      anywhere under `content/changelog/` is covered — the only reliable
 *      signal in the repo.
 *   2. Date. Commits older than the newest entry's date are assumed covered.
 *
 *      ⚠️ THIS HIDES OLDER UNCOVERED WORK, AND THAT IS THE TRADE. Write an
 *      entry dated today and yesterday's unlabelled commits stop being
 *      reported. Widening the window instead would resurface every
 *      "feat adding gantt chart" forever, because a commit with no backlog ID
 *      can never be proven covered. `--json` with a hand-edited window is the
 *      escape hatch when you want to audit further back.
 *   3. Subject shape. `chore:`/`docs:`/`ci:`, merges, reverts, reapplies and
 *      "trigger redeployment" are not things a colleague notices. Dropped.
 *
 * Whatever survives is *unexplained*, not necessarily changelog-worthy — half
 * the commit subjects on this branch are "feat adding gantt chart" or
 * "merging", so refs cannot be relied on to be present. The output is a
 * shortlist for a human read, never a verdict.
 *
 * Exit code is always 0. This is advisory: a missing changelog entry has never
 * been worth failing a commit or a build over.
 *
 *   node scripts/changelog-gap.mjs            # human report
 *   node scripts/changelog-gap.mjs --quiet    # print only if there is a gap
 *   node scripts/changelog-gap.mjs --json     # machine-readable
 *   node scripts/changelog-gap.mjs --hook     # Claude Code PostToolUse hook
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT_DIR = join(REPO, 'content', 'changelog')

/** Commit subjects nobody would read a changelog to learn about. */
const NOISE = [
  /^Merge\b/i,
  /^Revert\b/i,
  /^Reapply\b/i,
  /^merging$/i,
  /^(chore|docs|test|tests|ci|build|style|deps)\b/i,
  /trigger redeploy/i,
  /^stage changes$/i,
  /^wip\b/i,
]

/**
 * Backlog IDs as the commits and the `refs` arrays both spell them: `P8-18`,
 * `P11-03`, `D21`, `Q15`, `R11`. Kept deliberately narrow — a bare number or a
 * word would match half of every subject.
 */
const REF = /\b(?:P\d{1,2}-\d{1,3}|[DQR]\d{1,2})\b/g

/**
 * Touched path → the `area` badge. First match wins, so the specific patterns
 * come before the broad ones. `Platform` is the fallback, which is also what
 * the file uses for anything cross-cutting.
 */
const AREAS = [
  [/(^|\/)(timesheet|overtime)/, 'Timesheet'],
  [/(^|\/)(leave|hr)/, 'Leave'],
  [/(^|\/)dtr|attendance|dtr-schedule/, 'DTR'],
  [/(^|\/)(approvals?|respond|approve)/, 'Approvals'],
  // `request` on its own is too broad — `requests/` is the Gate-1 queue and
  // `lib/*-request*` is half the server layer. Only the public form counts.
  [/(^|\/)(forms?|form-builder)|^app\/request\//, 'Forms'],
  [/(^|\/)(reports?|analytics)/, 'Reporting'],
  [/(^|\/)(tasks?|personal-task|lists?)/, 'Tasks'],
]

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

/**
 * The newest entry's date, and every backlog ID anywhere in the changelog.
 *
 * Reads `content/changelog/*.json` — one file per entry. Plain `JSON.parse`
 * rather than importing `lib/changelog.ts`: this runs from a git hook, where
 * there is no TypeScript loader, no path alias and no build step to rely on.
 *
 * The refs are collected from the raw text rather than from the parsed `refs`
 * array on purpose — an ID mentioned in a `pending` sentence ("P13-02 is
 * written but not yet applied") counts as covered too.
 */
function readChangelog() {
  const dates = []
  const refs = new Set()

  for (const name of readdirSync(CONTENT_DIR)) {
    if (!name.endsWith('.json')) continue
    const raw = readFileSync(join(CONTENT_DIR, name), 'utf8')
    const entry = JSON.parse(raw)
    if (entry.date) dates.push(entry.date)
    for (const ref of raw.match(REF) ?? []) refs.add(ref)
  }

  return { newest: dates.sort().at(-1) ?? '1970-01-01', refs }
}

function areaFor(paths) {
  for (const [pattern, area] of AREAS) {
    if (paths.some((p) => pattern.test(p))) return area
  }
  return 'Platform'
}

function findGap() {
  const { newest, refs } = readChangelog()

  // `--since` is exclusive of the timestamp, so ask from the start of the
  // newest entry's own day: a feature and its write-up usually land together,
  // and a same-day commit gets filtered by ref below rather than by date.
  const log = git([
    'log',
    `--since=${newest} 00:00:00`,
    '--no-merges',
    '--pretty=format:%H%x1f%ad%x1f%s',
    '--date=short',
  ])

  const commits = []
  for (const line of log ? log.split('\n') : []) {
    const [sha, date, subject] = line.split('\x1f')
    if (!sha) continue
    if (NOISE.some((p) => p.test(subject))) continue

    const commitRefs = [...new Set(subject.match(REF) ?? [])]
    // Every ID this commit names is already written up. Covered.
    if (commitRefs.length > 0 && commitRefs.every((r) => refs.has(r))) continue

    const files = git(['show', '--name-only', '--pretty=format:', sha])
      .split('\n')
      .filter(Boolean)

    // Nothing a user could see. Migrations count — a table is how most
    // features arrive here — but a lone test or doc change does not.
    const userFacing = files.some(
      (f) =>
        !/^(tests?|docs)\//.test(f) &&
        !/^(CLAUDE|DESIGN|README)\.md$/.test(f) &&
        !/^\.(github|githooks|claude)\//.test(f),
    )
    if (!userFacing) continue

    commits.push({ sha: sha.slice(0, 7), date, subject, refs: commitRefs, area: areaFor(files), files: files.length })
  }

  return { newest, commits }
}

const flags = new Set(process.argv.slice(2))

/*
 * PostToolUse fires on every Bash call, so the hook has to decide for itself
 * whether this one was a commit — a matcher can only narrow to the tool. Read
 * the event off stdin and bail silently on anything else, or the reminder
 * would land on every `ls`.
 */
if (flags.has('--hook')) {
  let command = ''
  try {
    const event = JSON.parse(readFileSync(0, 'utf8'))
    command = event?.tool_input?.command ?? ''
  } catch {
    process.exit(0) // no event, or not JSON — say nothing
  }
  // `git commit`, but not `git commit --dry-run` and not a log of one.
  if (!/\bgit\s+(-\S+\s+|--\S+\s+)*commit\b/.test(command) || /--dry-run/.test(command)) {
    process.exit(0)
  }
}

const { newest, commits } = findGap()

if (flags.has('--json')) {
  console.log(JSON.stringify({ newestEntry: newest, gap: commits }, null, 2))
  process.exit(0)
}

if (flags.has('--hook')) {
  // The transcript already shows the commit, so say only what Claude would not
  // otherwise know — that an entry is owed, and for what.
  if (commits.length > 0) {
    const lines = commits.map((c) => `  ${c.sha}  [${c.area}]  ${c.subject}`).join('\n')
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `The changelog's newest entry is ${newest}, and ${commits.length} user-facing ` +
            `commit(s) since then are not covered by it:\n${lines}\n\n` +
            `If any of these shipped something a colleague would notice, use the ` +
            `\`changelog\` skill to add an entry under content/changelog/. If they are all ` +
            `internal, say nothing and carry on — do not mention this note.`,
        },
      }),
    )
  }
  process.exit(0)
}

if (commits.length === 0) {
  if (!flags.has('--quiet')) console.log(`changelog: up to date (newest entry ${newest}).`)
  process.exit(0)
}

console.log(`\nchangelog: newest entry is ${newest}; ${commits.length} commit(s) since then are not covered.\n`)
for (const c of commits) {
  const refs = c.refs.length > 0 ? `  refs ${c.refs.join(', ')}` : ''
  console.log(`  ${c.sha}  ${c.date}  [${c.area}]  ${c.subject}${refs}`)
}
console.log(`\n  → worth an entry? add one JSON file under content/changelog/, or run /changelog.`)
console.log(`  → advisory only; a commit that nobody would notice needs no entry.\n`)

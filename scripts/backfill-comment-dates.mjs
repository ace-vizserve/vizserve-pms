/**
 * P7-67 — give the imported comments back the dates they were written on.
 *
 * THE PROBLEM. Whatever loaded the 3,993-task slice stamped every comment with
 * the moment of the import: one `created_at` per task, identical across every
 * comment on it. A thread that happened over four days in November 2025 reads
 * as one instant in September 2026, in an order the database picks arbitrarily.
 * The real dates were in the export all along — every comment in column Y
 * carries `"date": "11/10/2025, 2:21:30 PM GMT+8"`.
 *
 * ⚠️ IT EMITS SQL RATHER THAN WRITING. `updated_at` cannot be set through the
 * API: `vizserve_pms_set_updated_at()` is a BEFORE UPDATE trigger doing
 * `new.updated_at = now()` unconditionally, so every attempt to restore it
 * overwrites itself. The backfill has to run with that trigger disabled, which
 * is `ALTER TABLE`, which is a thing to do deliberately in the SQL editor and
 * not from a script nobody is watching. Same posture as `import_01`..`import_06`.
 *
 * ⚠️ KEYED BY COMMENT ID, MATCHED BY TEXT. The match has to happen here, where
 * the export is; the SQL that comes out names ids and nothing else, so it
 * cannot re-interpret anything when it runs. Bodies that have already had their
 * images imported carry `<img src="/api/task-images/…">` where the export says
 * `image.png`, so those are normalised back before comparing — otherwise this
 * would silently skip every task the image import has already touched.
 *
 *   node scripts/backfill-comment-dates.mjs --data <export.json> --out <file.sql>
 *
 * Writes the undo beside it as `<file>.undo.sql`, holding the values as they are
 * now. Nothing is written to the database by this script at all.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const DATA = arg("data");
const OUT = arg("out", "supabase/backfill/comment-dates.sql");
if (!DATA) {
  console.error("usage: --data <export.json> [--out <file.sql>]");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/**
 * `11/10/2025, 2:21:30 PM GMT+8` -> `2025-11-10 14:21:30+08`
 *
 * Hand-rolled, and no date library — `lib/dates.ts` exists for exactly this
 * reason and a script is not an excuse to import one. The offset is carried
 * through into the literal rather than converted, so Postgres does the
 * conversion and the value is unambiguous whatever the server's timezone is.
 *
 * ⚠️ IT REFUSES ANYTHING IT DOES NOT RECOGNISE. A date this cannot parse must
 * stop the run: the alternative is a comment quietly keeping the import's
 * timestamp while everything around it moves, which is worse than all of them
 * being wrong together.
 */
function toTimestamptz(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\s*GMT([+-]\d{1,2})$/i.exec(
    (text || "").trim(),
  );
  if (!m) throw new Error(`unparseable comment date: ${JSON.stringify(text)}`);

  const [, month, day, year, hour12, minute, second, meridiem, offset] = m;
  let hour = Number(hour12) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;

  const pad = (n) => String(n).padStart(2, "0");
  const sign = offset.startsWith("-") ? "-" : "+";
  const hours = pad(Math.abs(Number(offset)));

  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${minute}:${second}${sign}${hours}`;
}

/**
 * Compare the way a reader would, and put an already-imported image back to the
 * token it replaced so a second pass still recognises the comment.
 */
const norm = (text) =>
  (text || "")
    .replace(/<img[^>]*src="\/api\/task-images\/[^"]*"[^>]*>/gi, "image.png")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const rows = JSON.parse(readFileSync(DATA, "utf8"));
const updates = [];
const undo = [];
let skipped = 0;
let ambiguous = 0;

for (const row of rows) {
  if (row.comments.length === 0) continue;

  const { data: task } = await db
    .from("vizserve_pms_tasks").select("id").eq("title", row.title).maybeSingle();
  if (!task) { skipped += row.comments.length; continue; }

  const { data: comments } = await db
    .from("vizserve_pms_task_comments")
    .select("id, body, created_at, updated_at")
    .eq("task_id", task.id);

  const taken = new Set();

  for (const exported of row.comments) {
    const key = norm(exported.text);
    const matches = (comments ?? []).filter((c) => norm(c.body) === key && !taken.has(c.id));

    if (matches.length === 0) { skipped += 1; continue; }
    if (matches.length > 1) { ambiguous += 1; continue; }

    const hit = matches[0];
    taken.add(hit.id);

    const at = toTimestamptz(exported.date);
    updates.push(
      `update vizserve_pms_task_comments set created_at = '${at}'::timestamptz,` +
      ` updated_at = '${at}'::timestamptz where id = '${hit.id}';`,
    );
    undo.push(
      `update vizserve_pms_task_comments set created_at = '${hit.created_at}'::timestamptz,` +
      ` updated_at = '${hit.updated_at}'::timestamptz where id = '${hit.id}';`,
    );
  }
}

const header = (what) => `-- ${what}
--
-- GENERATED by scripts/backfill-comment-dates.mjs. Do not hand-edit: it is keyed
-- by comment id, and those ids exist only in the project it was generated
-- against. On any other database every statement here matches zero rows, which
-- is why it lives outside supabase/migrations/ and never replays.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor.
--
-- ⚠️ THE TRIGGER IS DISABLED AROUND IT, AND THAT IS THE WHOLE POINT.
-- \`vizserve_pms_set_updated_at()\` sets \`new.updated_at = now()\` on every
-- update, so without this the "edited" mark this is trying to clear would be
-- re-applied by the very statement clearing it. Re-enabled in the same
-- transaction: a failure rolls the disable back with everything else.
--
-- \`vizserve_pms_task_comments_notify\` is AFTER INSERT only, so no inbox
-- notification is raised by any of this.

begin;

alter table vizserve_pms_task_comments disable trigger vizserve_pms_task_comments_updated_at;
`;

const footer = `
alter table vizserve_pms_task_comments enable trigger vizserve_pms_task_comments_updated_at;

commit;
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, header(`Restore the ClickUp dates on ${updates.length} imported comments.`) + updates.join("\n") + footer);
writeFileSync(`${OUT}.undo.sql`, header(`Undo: put ${undo.length} comments back as they were.`) + undo.join("\n") + footer);

console.log(`${updates.length} comments to restore`);
console.log(`${skipped} skipped (no matching comment in the app)`);
console.log(`${ambiguous} ambiguous (two comments with identical text)`);
console.log(`\n  ${OUT}\n  ${OUT}.undo.sql`);

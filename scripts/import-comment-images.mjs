/**
 * P7-67 — carry the ClickUp comment images into the app, one task at a time.
 *
 * ⚠️ DRY RUN UNLESS `--apply`. Without it this prints exactly what it would do
 * and touches nothing. With it, it writes to whatever `.env` points at, which on
 * this machine is PRODUCTION.
 *
 *   node scripts/import-comment-images.mjs --data <export.json> --task "<title>"
 *   node scripts/import-comment-images.mjs --data <export.json> --task "<title>" --apply
 *
 * `--data` is the JSON produced from the ClickUp xlsx export: an array of
 * `{ clickup_id, title, attachments: [{title, url}], comments: [{text, by, date}] }`.
 *
 * ⚠️ THE THREE RULES THIS ENCODES, each established by inspecting the real data
 * rather than assumed. Changing any of them silently puts the wrong picture
 * under the wrong comment, and the totals still reconcile, so nothing catches it:
 *
 *   1. THE TASK comes from the export row. The attachment URL carries no task
 *      id — its middle path segment is a per-attachment uuid, and none of the
 *      3,785 task ids in the export appears in any of the 640 URLs.
 *
 *   2. THE COMMENT is matched BY TEXT, never by order. Every comment the
 *      original import wrote shares one `created_at` — one distinct timestamp
 *      per task — so `order by created_at` is arbitrary. Text matched 57 of 57
 *      on the security-audit tasks with zero ambiguity.
 *
 *   3. THE ATTACHMENT ARRAY IS NEWEST-UPLOAD-FIRST, and so is the export's
 *      comment array, so the two walk together. But WITHIN one comment's run the
 *      order reverses: on the November audit, the sign-in screenshot carrying
 *      the column headers (11/6→11/4) sits AFTER its own continuation
 *      (11/4→11/2) in the array, because it was pasted first. Verified by
 *      downloading the files and reading them.
 *
 * ⚠️ ATTACHMENTS LEFT OVER AFTER EVERY TOKEN IS SATISFIED ARE NOT COMMENT
 * IMAGES. On the November task the trailing four are from the OCTOBER cycle —
 * a Secure Score calculated 10/13 against that month's 11/10. They go to the
 * Files panel as `reference` rather than being forced into a comment.
 *
 * A rollback file is written BEFORE anything changes and updated after every
 * insert: it holds each original comment body and every attachment id and
 * storage path created. `--rollback <file>` to choose where.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const BUCKET = "request-attachments";

/**
 * ⚠️ A FLAG WITH NO VALUE FALLS BACK, it does not return `undefined`. A long
 * command pasted into a shell wraps, and the wrap lands between a flag and its
 * value — `--rollback` at the end of one line put `undefined` into
 * `writeFileSync` and crashed a run that had already written to the database.
 * A missing value and an absent flag are the same thing.
 */
function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;

  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) return fallback;
  return value;
}

const APPLY = process.argv.includes("--apply");
const DATA = arg("data");
const TITLE = arg("task");
/**
 * ⚠️ PREFER `--id`. These titles run to seventy characters and contain commas,
 * colons and brackets — pasted into PowerShell they wrap, and a wrapped title
 * arrives with a newline and two spaces in the middle of it, which matches
 * nothing. The ClickUp id is nine characters and has no spaces at all.
 */
const ID = arg("id");
/**
 * Every task in the file, rather than one. The per-task guards are what make
 * this safe in bulk: a task whose comments do not match is SKIPPED and reported,
 * never guessed at, so a run of a hundred cannot quietly produce one wrong
 * thread. A task already carrying `/api/task-images/` links is skipped too,
 * which is what lets an interrupted run simply be run again.
 */
const ALL = process.argv.includes("--all");
/*
 * Its own file per run, so nothing has to be remembered on the command line and
 * a second run cannot overwrite the ledger of the first — which is the only
 * record of what a previous run wrote.
 */
const ROLLBACK = arg("rollback", `rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

if (!DATA || (!TITLE && !ID && !ALL)) {
  console.error("usage: --data <export.json> (--all | --id <clickup id> | --task \"<title>\") [--apply] [--rollback <file>]");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, ""),
    ]),
);

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const flat = (text) => (text || "").replace(/\s+/g, " ").trim();

const rows = JSON.parse(readFileSync(DATA, "utf8"));

let selected;
if (ALL) {
  selected = rows.filter((entry) => entry.attachments.length > 0);
} else {
  const one = ID
    ? rows.find((entry) => entry.clickup_id === ID)
    // Whitespace-insensitive, so a title that wrapped on the way through a shell
    // still finds its row rather than failing on two spaces nobody typed.
    : rows.find((entry) => flat(entry.title) === flat(TITLE));

  if (!one) {
    console.error(`no export row for ${ID ? `id ${ID}` : JSON.stringify(flat(TITLE))}. available:`);
    for (const entry of rows) {
      if (entry.attachments.length) console.error(`  ${entry.clickup_id}  ${entry.title}`);
    }
    process.exit(1);
  }
  selected = [one];
}

/** Compare the way a reader would: markup and whitespace are not the content. */
const norm = (text) =>
  text.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** PNG IHDR — width at 16, height at 20. Every file in this export is a PNG. */
function pngSize(buffer) {
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return {
    width,
    height,
    orientation: width > height ? "landscape" : height > width ? "portrait" : "square",
  };
}

const escapeAttr = (text) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Everything written by a run, appended to as it happens.
 *
 * ⚠️ FLUSHED AFTER EVERY SINGLE INSERT, not at the end. A run over a hundred
 * tasks will be interrupted eventually — a network blip, a rate limit, a closed
 * laptop — and a rollback file that only exists on a clean finish is a rollback
 * file for the one case that does not need it.
 */
const ledger = { started: new Date().toISOString(), tasks: [] };
const flush = () => writeFileSync(ROLLBACK, JSON.stringify(ledger, null, 2));

/** Fetch from ClickUp, put it in our bucket, record the row. */
async function store(taskId, attachment, kind, entry) {
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`fetch ${response.status} for ${attachment.url}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const size = pngSize(buffer);
  const path = `tasks/${taskId}/${crypto.randomUUID()}/${attachment.title.replace(/[^\w.\-]+/g, "_")}`;

  const { error: uploadError } = await db.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: response.headers.get("content-type") || "image/png", upsert: false });
  if (uploadError) throw new Error(`upload: ${uploadError.message}`);

  const { data: created, error: rowError } = await db
    .from("vizserve_pms_task_attachments")
    .insert({
      task_id: taskId,
      storage_path: path,
      filename: attachment.title,
      mime_type: response.headers.get("content-type") || "image/png",
      size_bytes: buffer.length,
      kind,
      // Nobody in this app uploaded it. A real uploader would be a lie, and the
      // column is nullable precisely for a row that arrived by import.
      uploaded_by: null,
    })
    .select("id")
    .single();
  if (rowError) throw new Error(`row: ${rowError.message}`);

  entry.created.push({ id: created.id, path });
  flush();

  return { id: created.id, size };
}

/**
 * Work out what a single task needs. Returns `{ skip }` rather than throwing:
 * in a bulk run one odd task must not take the other hundred with it.
 */
async function planFor(row) {
  /*
   * ⚠️ NOT `maybeSingle()`. Two tasks can share a title — "Registration Page"
   * and "Enrolment Page" each appear twice in VizBytes — and `maybeSingle()`
   * answers a duplicate with null, which reads as "no such task" and sends
   * somebody looking for a task that is right there. Ask for the rows and say
   * which of the two problems it actually is.
   */
  const { data: candidates } = await db
    .from("vizserve_pms_tasks").select("id, title").eq("title", row.title);

  if (!candidates || candidates.length === 0) return { skip: "no task with this title in the app" };
  if (candidates.length > 1) return { skip: `${candidates.length} tasks share this title` };

  const task = candidates[0];

  const { data: comments } = await db
    .from("vizserve_pms_task_comments").select("id, body").eq("task_id", task.id);

  if ((comments ?? []).some((c) => c.body.includes("/api/task-images/"))) {
    return { skip: "already imported" };
  }

  /*
   * ⚠️ AND A FILES-ONLY TASK NEEDS ITS OWN CHECK. The body scan above sees
   * nothing on a task whose attachments were all filed rather than placed, so a
   * re-run after an interruption would upload every one of them a second time.
   *
   * `uploaded_by is null` is the marker: a file that arrived by import has no
   * uploader, and every file a person added through the app has one. It is the
   * only thing that distinguishes them, and it is why this script writes null
   * rather than inventing an uploader.
   */
  const { count: imported } = await db
    .from("vizserve_pms_task_attachments")
    .select("id", { count: "exact", head: true })
    .eq("task_id", task.id)
    .is("uploaded_by", null);

  if ((imported ?? 0) > 0) return { skip: `already has ${imported} imported file(s)` };

  const steps = [];
  let cursor = 0;

  for (const exported of row.comments) {
    const matches = (comments ?? []).filter((c) => norm(c.body) === norm(exported.text || ""));

    // Refuse rather than guess. A comment matching none or several is the one
    // case where a wrong answer is worse than no answer.
    if (matches.length !== 1) {
      return { skip: `a comment matched ${matches.length} in the app` };
    }

    const tokens = (matches[0].body.match(/image\.png/gi) ?? []).length;
    steps.push({
      comment: matches[0],
      // Newest-first overall, so one comment's run reads backwards.
      run: row.attachments.slice(cursor, cursor + tokens).reverse(),
    });
    cursor += tokens;
  }

  return { task, steps, leftovers: row.attachments.slice(cursor), placed: cursor };
}

let placedTotal = 0;
let filedTotal = 0;
const skipped = [];
const failed = [];

for (const row of selected) {
  const plan = await planFor(row);

  if (plan.skip) {
    skipped.push({ title: row.title, why: plan.skip });
    console.log(`SKIP  ${String(row.attachments.length).padStart(3)}f  ${row.title.slice(0, 52)}  — ${plan.skip}`);
    continue;
  }

  console.log(
    `${APPLY ? "RUN " : "PLAN"}  ${String(row.attachments.length).padStart(3)}f` +
    `  ${String(plan.placed).padStart(3)} placed  ${String(plan.leftovers.length).padStart(3)} filed` +
    `  ${row.title.slice(0, 46)}`,
  );

  placedTotal += plan.placed;
  // Counted on the way out, not here: a leftover that could not be fetched is
  // not a file anybody has.
  if (!APPLY) filedTotal += plan.leftovers.length;

  if (!APPLY) continue;

  const entry = { task: plan.task.id, title: row.title, comments: [], created: [] };
  ledger.tasks.push(entry);

  // The bodies BEFORE anything is touched, so an undo has somewhere to go.
  for (const step of plan.steps) entry.comments.push({ id: step.comment.id, body: step.comment.body });
  flush();

  for (const { comment, run } of plan.steps) {
    const caption = comment.body.split("\n")[0].trim() || "Screenshot";
    let body = comment.body;

    for (let index = 0; index < run.length; index += 1) {
      const { id, size } = await store(plan.task.id, run[index], "comment", entry);
      const alt = run.length > 1 ? `${caption} (${index + 1})` : caption;
      const dimensions = size
        ? ` width="${size.width}" height="${size.height}" data-orientation="${size.orientation}"`
        : "";

      // The FIRST remaining token, so a run lands left to right. The token is
      // replaced rather than kept: "image.png" is not something anybody wrote,
      // it is how the export renders an inline image.
      body = body.replace(/image\.png/i, `<img src="/api/task-images/${id}" alt="${escapeAttr(alt)}"${dimensions}>`);
    }

    const { error } = await db.from("vizserve_pms_task_comments").update({ body }).eq("id", comment.id);
    if (error) throw new Error(`update comment: ${error.message}`);
  }

  for (const attachment of plan.leftovers) {
    /*
     * ⚠️ ONE FILE FAILING MUST NOT END THE RUN. A file panel's worth of
     * leftovers is not worth abandoning four hundred good ones for, and the
     * export carries links that CANNOT be fetched at all: four SharePoint
     * `Doc.aspx` viewer URLs, which answer an unauthenticated request with a
     * sign-in page rather than a document. Those are recorded and skipped.
     *
     * A failure inside a COMMENT's run is different and is still fatal — there
     * the image has a place in a body, and half-filling a body would leave a
     * comment whose remaining `image.png` tokens can never be matched again.
     */
    try {
      await store(plan.task.id, attachment, "reference", entry);
      filedTotal += 1;
    } catch (error) {
      failed.push({ title: row.title, file: attachment.title, why: String(error.message ?? error) });
      console.log(`      could not fetch ${attachment.title.slice(0, 40)} — ${String(error.message ?? error).slice(0, 60)}`);
    }
  }
}

console.log(`\n${APPLY ? "applied" : "would apply"}: ${placedTotal} placed in comments, ${filedTotal} filed as task attachments`);
if (skipped.length) console.log(`${skipped.length} task(s) skipped`);
if (failed.length) {
  console.log(`${failed.length} file(s) could not be fetched:`);
  for (const f of failed) console.log(`  ${f.file.slice(0, 44)}  (${f.title.slice(0, 30)})`);
}
if (!APPLY) console.log("\nnothing written. re-run with --apply");
else console.log(`\nrollback: ${ROLLBACK}`);

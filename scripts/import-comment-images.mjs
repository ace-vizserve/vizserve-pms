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

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
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
const ROLLBACK = arg("rollback", "rollback-comment-images.json");

if (!DATA || (!TITLE && !ID)) {
  console.error("usage: --data <export.json> (--id <clickup id> | --task \"<title>\") [--apply] [--rollback <file>]");
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
const row = ID
  ? rows.find((entry) => entry.clickup_id === ID)
  // Whitespace-insensitive, so a title that wrapped on the way through a shell
  // still finds its row rather than failing on two spaces nobody typed.
  : rows.find((entry) => flat(entry.title) === flat(TITLE));

if (!row) {
  console.error(`no export row for ${ID ? `id ${ID}` : JSON.stringify(flat(TITLE))}. available:`);
  for (const entry of rows) {
    if (entry.attachments.length) console.error(`  ${entry.clickup_id}  ${entry.title}`);
  }
  process.exit(1);
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

// The export row is the source of the title now, not the command line.
const { data: task } = await db
  .from("vizserve_pms_tasks")
  .select("id, title")
  .eq("title", row.title)
  .maybeSingle();

if (!task) throw new Error(`the app has no task titled ${row.title}`);

const { data: appComments } = await db
  .from("vizserve_pms_task_comments")
  .select("id, body")
  .eq("task_id", task.id);

const plan = [];
let cursor = 0;

for (const exported of row.comments) {
  const matches = (appComments ?? []).filter((c) => norm(c.body) === norm(exported.text || ""));

  // Refuse rather than guess. A comment that matches none or several is the one
  // case where a wrong answer is worse than no answer.
  if (matches.length !== 1) {
    /*
     * ⚠️ THE COMMON CAUSE IS A SECOND RUN, NOT A BROKEN MATCH. A successful
     * import replaces the `image.png` token with an `<img>`, so the body no
     * longer reads like the export and matches nothing — which is exactly the
     * protection you want, and it should say so rather than report a bare zero.
     */
    const already = (appComments ?? []).some((c) => c.body.includes("/api/task-images/"));
    if (already) {
      console.error(`${row.title}`);
      console.error("  ALREADY IMPORTED — its comments already carry /api/task-images/ links.");
      console.error("  undo with the rollback file before running this again.");
      process.exit(1);
    }

    throw new Error(
      `matched ${matches.length} app comments for ${JSON.stringify((exported.text || "").slice(0, 50))}`,
    );
  }

  const tokens = (matches[0].body.match(/image\.png/gi) ?? []).length;
  plan.push({
    comment: matches[0],
    run: row.attachments.slice(cursor, cursor + tokens).reverse(),
  });
  cursor += tokens;
}

const leftovers = row.attachments.slice(cursor);

console.log(`${APPLY ? "APPLY" : "DRY RUN"}  ${task.id}  ${row.title}`);
console.log(`  ${cursor} image(s) across ${plan.length} comment(s), ${leftovers.length} unplaced\n`);

for (const { comment, run } of plan) {
  const caption = comment.body.split("\n")[0].trim() || "Screenshot";
  console.log(`  ${caption.slice(0, 40).padEnd(40)} ${run.length} image(s)`);
}

if (!APPLY) {
  console.log("\nnothing written. re-run with --apply");
  process.exit(0);
}

const rollback = {
  task: task.id,
  comments: plan.map((entry) => ({ id: entry.comment.id, body: entry.comment.body })),
  created: [],
};
writeFileSync(ROLLBACK, JSON.stringify(rollback, null, 2));

/** Fetch from ClickUp, put it in our bucket, record the row. */
async function store(attachment, kind) {
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`fetch ${response.status} for ${attachment.url}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const size = pngSize(buffer);
  const path = `tasks/${task.id}/${crypto.randomUUID()}/image.png`;

  const { error: uploadError } = await db.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: "image/png", upsert: false });
  if (uploadError) throw new Error(`upload: ${uploadError.message}`);

  const { data: created, error: rowError } = await db
    .from("vizserve_pms_task_attachments")
    .insert({
      task_id: task.id,
      storage_path: path,
      filename: attachment.title,
      mime_type: "image/png",
      size_bytes: buffer.length,
      kind,
      // Nobody in this app uploaded it. A real uploader would be a lie, and the
      // column is nullable precisely for a row that arrived by import.
      uploaded_by: null,
    })
    .select("id")
    .single();
  if (rowError) throw new Error(`row: ${rowError.message}`);

  // Written after EVERY insert, not at the end: a crash halfway through must
  // still leave a complete list of what to undo.
  rollback.created.push({ id: created.id, path });
  writeFileSync(ROLLBACK, JSON.stringify(rollback, null, 2));

  return { id: created.id, size, bytes: buffer.length };
}

for (const { comment, run } of plan) {
  const caption = comment.body.split("\n")[0].trim() || "Screenshot";
  let body = comment.body;

  for (let index = 0; index < run.length; index += 1) {
    const { id, size, bytes } = await store(run[index], "comment");
    const alt = run.length > 1 ? `${caption} (${index + 1})` : caption;
    const dimensions = size
      ? ` width="${size.width}" height="${size.height}" data-orientation="${size.orientation}"`
      : "";

    // The FIRST remaining token, so the run lands left to right. The token is
    // replaced rather than kept beside the picture: "image.png" was never
    // anything anybody wrote, it is how ClickUp's export renders an inline
    // image, and leaving it prints a filename under every screenshot.
    body = body.replace(/image\.png/i, `<img src="/api/task-images/${id}" alt="${escapeAttr(alt)}"${dimensions}>`);

    console.log(`  ${caption.slice(0, 34).padEnd(34)} <- ${size?.width}x${size?.height}  ${(bytes / 1024).toFixed(0)}KB`);
  }

  const { error } = await db
    .from("vizserve_pms_task_comments")
    .update({ body })
    .eq("id", comment.id);
  if (error) throw new Error(`update comment: ${error.message}`);
}

for (const attachment of leftovers) {
  const { size, bytes } = await store(attachment, "reference");
  console.log(`  [unplaced -> Files panel]          <- ${size?.width}x${size?.height}  ${(bytes / 1024).toFixed(0)}KB`);
}

console.log(`\ndone. rollback: ${ROLLBACK}`);

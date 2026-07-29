#!/usr/bin/env node
/**
 * Fails the build if `user_metadata` is read anywhere outside presentation code.
 *
 * Why this exists (docs/02-data-model.md §Auth metadata): `raw_user_meta_data`
 * is writable by the user through Supabase's own GoTrue endpoint —
 *
 *   curl -X PUT 'https://<ref>.supabase.co/auth/v1/user' \
 *     -H "Authorization: Bearer <their own access token>" \
 *     -d '{"data": {"role": "admin"}}'
 *
 * — which this application does not own and cannot remove. Today nothing trusts
 * it, so a spoofed claim buys an attacker a misleading nav bar and nothing else.
 * That holds only while every reader stays disciplined. One convenient
 * `if (user.user_metadata.role === 'admin')` in a server action turns it into a
 * full privilege escalation with no audit trail.
 *
 * Authorization reads `vizserve_pms_users.role`, via lib/auth/authorization.ts
 * and RLS. Nothing else.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "components", "utils", "hooks"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const NEEDLE = /user_metadata|raw_user_meta_data/;

/**
 * Files permitted to touch the claim, for display and routing only.
 * Adding to this list is a decision, not a formality — say why in the PR.
 */
const ALLOWLIST = new Set([]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }

  return out;
}

/** Strips comments so the rule bites on code, not on the docs explaining it. */
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (ALLOWLIST.has(rel)) continue;

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      if (NEEDLE.test(line)) {
        violations.push({ file: rel, line: index + 1, text: line.trim() });
      }
    });
  }
}

if (violations.length > 0) {
  console.error("\n✗ user_metadata is referenced in non-presentation code.\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}\n`);
  }
  console.error("`user_metadata` is user-writable via Supabase's auth endpoint and must never");
  console.error("appear in an authorization decision. Use lib/auth/authorization.ts, which reads");
  console.error("vizserve_pms_users.role. See docs/02-data-model.md §Auth metadata.\n");
  process.exit(1);
}

console.log("✓ no user_metadata references in the authorization path");

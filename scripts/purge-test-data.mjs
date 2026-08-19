#!/usr/bin/env node
/**
 * Empty the transactional tables, keep the accounts.
 *
 * Months of QA runs and test-suite fixtures accumulate in a dev database — P6
 * timesheet fixtures, hundreds of notifications, tasks nobody recognises — and
 * they make the app impossible to look at. This clears the work and leaves the
 * setup: the sixteen `test.` accounts, the departments they lead, and the
 * reference tables the migrations own.
 *
 * DRY RUN BY DEFAULT. It prints what it would delete and exits. Pass `--yes` to
 * actually delete. There is no undo.
 *
 * Usage:
 *   node scripts/purge-test-data.mjs            # count only
 *   node scripts/purge-test-data.mjs --yes      # delete
 *   node scripts/purge-test-data.mjs --yes --forms   # also drop forms/fields
 *
 * Needs: SUPABASE_SECRET_KEY in .env (service role — bypasses RLS, though it
 * still needs the GRANTs; see the note in CLAUDE.md about the two gates).
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- env ------------------------------------------------------------------
function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (env[key]) continue;
        env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // file absent — fine
    }
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
  process.exit(1);
}

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const apply = process.argv.includes("--yes");
const includeForms = process.argv.includes("--forms");

/**
 * NEVER TOUCHED. Listed rather than implied, so that adding a table to the
 * delete list below is a deliberate act and not something that happens because
 * a name looked transactional.
 *
 *   users / user_managed_departments   the accounts, which is the whole point
 *   departments                        org structure, not test data
 *   task_transitions                   the state machine — migration-owned, and
 *                                      tests/db/tasks.test.ts asserts it matches
 *                                      lib/schemas/tasks.ts row for row
 *   holidays / leave_types             reference data
 *   notification_type_settings         config
 *   attachment_rules                   config
 *   public_submission_limits           rate-limit config
 */
const KEEP = [
  "vizserve_pms_users",
  "vizserve_pms_user_managed_departments",
  "vizserve_pms_departments",
  "vizserve_pms_task_transitions",
  "vizserve_pms_holidays",
  "vizserve_pms_leave_types",
  "vizserve_pms_notification_type_settings",
  "vizserve_pms_attachment_rules",
  "vizserve_pms_public_submission_limits",
  // P7-18. Folders are structure, not records of something happening — the same
  // reason `departments` is kept. And the reserved "Client Requests" folder
  // CANNOT be deleted at all: `vizserve_pms_task_groups_system_guard` raises on
  // DELETE, so putting this table in PURGE below would make the generic delete
  // fail and exit(1) rather than merely wiping too much.
  "vizserve_pms_task_groups",
];

/**
 * Delete order is CHILD FIRST. Most of these have ON DELETE CASCADE, but not
 * all do, and a script that relies on cascade order it has not checked fails
 * halfway through and leaves the database in a state nobody planned.
 */
const PURGE = [
  // task subtree
  "vizserve_pms_task_attachments",
  "vizserve_pms_task_comments",
  "vizserve_pms_task_status_history",
  // approvals reach both requests and internal requests, so they go before both
  "vizserve_pms_client_decisions",
  "vizserve_pms_feedback",
  "vizserve_pms_approval_tokens",
  "vizserve_pms_approvals",
  "vizserve_pms_tasks",
  // request subtree
  "vizserve_pms_request_attachments",
  "vizserve_pms_requests",
  "vizserve_pms_pending_attachments",
  "vizserve_pms_public_submission_log",
  // internal requests (leave, overtime, the two corrections, reimbursement)
  "vizserve_pms_internal_requests",
  // time
  "vizserve_pms_timesheet_entries",
  "vizserve_pms_timesheet_weeks",
  "vizserve_pms_dtr_entries",
  // everything else that is a record of something happening
  "vizserve_pms_notifications",
  "vizserve_pms_audit_logs",
  // Lists go before `forms` (which is --forms only). `forms.default_list_id` is
  // ON DELETE SET NULL, so wiping lists nulls the column rather than raising —
  // which is also why every surviving form needs its inbox list rebuilt
  // afterwards. See `reensureFormLists` below.
  "vizserve_pms_lists",
];

/**
 * Tables whose primary key is not `id`.
 *
 * `vizserve_pms_reference_counters` is keyed `(form_id, year)`, so the generic
 * count and delete below — both of which reach for `id` — silently return null
 * against it rather than failing loudly. The column to filter on is named here
 * instead.
 *
 * It is purged for the same reason the rest is: leaving the counters would have
 * the first request after a purge come back as PDY2-2026-0287 against an
 * otherwise empty table, which reads as data loss rather than a fresh start.
 */
const KEY_COLUMN = { vizserve_pms_reference_counters: "form_id" };

PURGE.push("vizserve_pms_reference_counters");

/**
 * Forms are OPT-IN (`--forms`), because they are the one thing in this list
 * that might not be test data. `supabase/seed-dev.sql` inserts one as a
 * fixture, but a form built through the builder is real configuration somebody
 * spent time on — and `field_key` immutability plus the soft-archive rule (R5)
 * exist precisely because form definitions are meant to outlive their
 * submissions.
 */
const FORMS = ["vizserve_pms_form_fields", "vizserve_pms_forms"];

function keyOf(table) {
  return KEY_COLUMN[table] ?? "id";
}

async function countOf(table) {
  const { count, error } = await supabase
    .from(table)
    .select(keyOf(table), { count: "exact", head: true });
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

async function main() {
  /*
   * THE PRODUCTION GUARD, and the reason this script is safe to keep in the
   * repo. Every seeded account is `@example.com` — an IANA-reserved domain that
   * cannot route to a real person — and a production smoke check asserts there
   * are zero of them. So: if this database contains a user who is NOT on
   * example.com, it is not a dev database and this script refuses to run.
   */
  const { data: users, error: usersError } = await supabase
    .from("vizserve_pms_users")
    .select("email");

  if (usersError) {
    console.error(`Could not read users: ${usersError.message}`);
    process.exit(1);
  }

  const real = (users ?? []).filter((user) => !user.email.endsWith("@example.com"));
  if (real.length > 0) {
    console.error(
      `REFUSING: ${real.length} account(s) are not @example.com, so this is not a dev database.\n` +
        real.map((user) => `  ${user.email}`).join("\n"),
    );
    process.exit(1);
  }

  const tables = includeForms ? [...PURGE, ...FORMS] : PURGE;

  console.log(
    `${apply ? "Deleting" : "Would delete"} from ${tables.length} tables.` +
      ` Keeping ${users?.length ?? 0} accounts and ${KEEP.length} config tables.\n`,
  );

  let total = 0;
  const failures = [];

  for (const table of tables) {
    const before = await countOf(table);

    if (before.error) {
      // A missing table is not a failure — the schema has grown over seven
      // phases and a fresh checkout may not have every migration applied.
      console.log(`  ${table.padEnd(42)} skipped (${before.error})`);
      continue;
    }

    if (before.count === 0) {
      console.log(`  ${table.padEnd(42)} empty`);
      continue;
    }

    total += before.count;

    if (!apply) {
      console.log(`  ${table.padEnd(42)} ${String(before.count).padStart(6)} rows`);
      continue;
    }

    // `.neq("id", <impossible uuid>)` is how PostgREST is told "every row":
    // a DELETE with no filter is rejected outright, which is a good default and
    // an inconvenience exactly once.
    const { error } = await supabase
      .from(table)
      .delete()
      .neq(keyOf(table), "00000000-0000-0000-0000-000000000000");

    if (error) {
      failures.push(`${table}: ${error.message}`);
      console.log(`  ${table.padEnd(42)} FAILED — ${error.message}`);
    } else {
      console.log(`  ${table.padEnd(42)} ${String(before.count).padStart(6)} deleted`);
    }
  }

  console.log();

  if (!apply) {
    console.log(`${total} rows would be deleted. Re-run with --yes to do it.`);
    if (!includeForms) {
      console.log("Forms and their fields are kept. Add --forms to drop those too.");
    }
    return;
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} table(s) failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\n`permission denied for table …` is a missing GRANT, never RLS — the service " +
        "role bypasses policies but still needs privileges. See CLAUDE.md.",
    );
    process.exit(1);
  }

  await reensureFormLists(supabase, includeForms);

  console.log(`Done. ${total} rows deleted; accounts and configuration untouched.`);
}

/**
 * P7-18 — rebuild each surviving form's inbox list.
 *
 * `vizserve_pms_lists` is purged and `forms.default_list_id` is ON DELETE SET
 * NULL, so without this every form that survives a purge is left pointing at
 * nothing, with no list in its department's Client Requests folder. Approved
 * requests would then land loose, and nothing would say why — the folder would
 * simply be empty forever.
 *
 * NOT DONE BY THE TRIGGER. `vizserve_pms_forms_sync_list` fires on insert and on
 * update of `department_id`; a purge touches neither, so nothing re-fires on its
 * own. This calls the same function the trigger does, so there is one definition
 * of what a form's list is.
 *
 * Skipped when the forms themselves were dropped — there is nothing left to
 * point anywhere.
 */
async function reensureFormLists(supabase, includeForms) {
  if (includeForms) return;

  const { data: forms, error } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name")
    .not("department_id", "is", null);

  if (error) {
    // Not fatal. The purge itself succeeded, and a form with no inbox list is
    // repaired by re-saving it in the UI — so this reports rather than exits.
    console.warn(`
  Could not rebuild form lists: ${error.message}`);
    console.warn("  Re-save each form's department in /forms to fix it.");
    return;
  }

  if (!forms || forms.length === 0) return;

  let rebuilt = 0;
  for (const form of forms) {
    const { error: ensureError } = await supabase.rpc("vizserve_pms_ensure_form_list", {
      p_form_id: form.id,
    });

    if (ensureError) {
      console.warn(`  ${form.name}: ${ensureError.message}`);
    } else {
      rebuilt += 1;
    }
  }

  console.log(`Rebuilt the Client Requests list for ${rebuilt} form(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

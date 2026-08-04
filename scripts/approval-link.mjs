#!/usr/bin/env node
/**
 * Prints a working client-approval link, for smoke testing without email.
 *
 * WHY THIS EXISTS. Gate 3 is reached by clicking a link in an email, and with
 * no RESEND_API_KEY the mailer runs in dry-run — it renders the message, logs
 * the subject, and sends nothing. So the flow is complete and the link is
 * unreachable, which makes the one screen a client actually sees untestable.
 *
 * This mints a fresh token for a task already sitting in FOR_CLIENT_APPROVAL and
 * prints the URL. It is exactly what the reminder cron does (P4-08), for exactly
 * the same reason: the raw token from the first email cannot be recovered,
 * because only its hash was ever stored.
 *
 * NOT A BACK DOOR. It needs SUPABASE_SECRET_KEY, which never reaches a browser,
 * and `vizserve_pms_issue_approval_token` is granted to service_role only —
 * neither `anon` nor a signed-in Team Leader can call it, precisely so that
 * nobody can mint themselves an approval for their own work.
 *
 * Usage:
 *   node scripts/approval-link.mjs            # the most recent one
 *   node scripts/approval-link.mjs <task-id>  # a specific task
 *   npm run smoke:approval-link
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match || env[match[1]]) continue;
        env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // absent file is fine
    }
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  console.error("\n✗ Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.\n");
  process.exit(1);
}

// Port 3000 on the build machine is the HFSE SIS app, whose login page also
// says "Welcome back" — so a wrong default here fails silently and convincingly.
const site = (env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3177").replace(/\/+$/, "");

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const requestedTaskId = process.argv[2];

async function main() {
  let query = supabase
    .from("vizserve_pms_tasks")
    .select("id, title, status, request_id")
    .eq("status", "FOR_CLIENT_APPROVAL")
    .order("updated_at", { ascending: false })
    .limit(1);

  if (requestedTaskId) {
    query = supabase
      .from("vizserve_pms_tasks")
      .select("id, title, status, request_id")
      .eq("id", requestedTaskId)
      .limit(1);
  }

  const { data: tasks, error } = await query;
  if (error) throw new Error(error.message);

  const task = tasks?.[0];

  if (!task) {
    console.error(
      "\n✗ No task is waiting for client approval.\n\n" +
        "  Drive one there first: submit a request on a published form, approve it\n" +
        "  as the department's TL, then move it OPEN → ONGOING → FOR_QA →\n" +
        "  QA_IN_PROGRESS → FOR_CLIENT_APPROVAL. The resolution must be filled in\n" +
        "  before FOR_QA is reachable — that gate is real.\n",
    );
    process.exit(1);
  }

  if (task.status !== "FOR_CLIENT_APPROVAL") {
    console.error(`\n✗ That task is ${task.status}, not FOR_CLIENT_APPROVAL.\n`);
    process.exit(1);
  }

  const { data: issued, error: issueError } = await supabase.rpc(
    "vizserve_pms_issue_approval_token",
    { p_task_id: task.id, p_purpose: "approval" },
  );

  if (issueError) throw new Error(issueError.message);

  const { data: request } = task.request_id
    ? await supabase
        .from("vizserve_pms_requests")
        .select("reference_no, requester_email")
        .eq("id", task.request_id)
        .maybeSingle()
    : { data: null };

  console.log(`\n  ${request?.reference_no ?? "(no reference)"} — ${task.title}`);
  console.log(`  client:   ${issued.requester_email}`);
  console.log(`  closes:   ${issued.auto_complete_at ?? "—"}`);
  console.log(`\n  ${site}/approve/${issued.token}\n`);
  console.log("  Open it in a private window — the page takes no session, and a");
  console.log("  signed-in one proves nothing about what a client would see.\n");
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});

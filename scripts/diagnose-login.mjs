#!/usr/bin/env node
/**
 * Login diagnostics.
 *
 * "I cannot log in" has several distinct causes that look identical from the
 * browser, so this separates them:
 *
 *   1. auth rejects the credentials      -> the account or password is wrong
 *   2. auth accepts but email unconfirmed -> Supabase refuses the sign-in
 *   3. auth accepts, profile missing      -> app bounces /dashboard -> /login
 *   4. auth accepts, profile inactive     -> same bounce, different reason
 *
 * 3 and 4 are the interesting ones: sign-in genuinely succeeds and the app
 * still returns you to the login screen, because requireAuthContext() treats a
 * missing or deactivated profile as "no session".
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        if (env[match[1]]) continue;
        env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      /* absent */
    }
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = env.SUPABASE_SECRET_KEY;

const EMAIL = process.argv[2] ?? "test.admin@example.com";
const PASSWORD = process.argv[3] ?? "VizServe2026!dev";

console.log(`\nProject: ${url}`);
console.log(`Testing: ${EMAIL}\n`);

// --- 1. does auth accept the credentials? ----------------------------------
const anon = createClient(url, publishable, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
  email: EMAIL,
  password: PASSWORD,
});

if (signInError) {
  console.log(`  [1] sign-in: FAILED — ${signInError.message}`);
  console.log(`      status: ${signInError.status}`);
} else {
  console.log(`  [1] sign-in: OK — user id ${signIn.user?.id}`);
  console.log(`      email_confirmed_at: ${signIn.user?.email_confirmed_at ?? "NULL (unconfirmed)"}`);
}

// --- 2. what does the app see after sign-in? -------------------------------
if (signIn?.session) {
  const { data: profile, error: profileError } = await anon
    .from("vizserve_pms_users")
    .select("id, email, role, is_active")
    .eq("id", signIn.user.id)
    .maybeSingle();

  if (profileError) {
    console.log(`  [2] profile read: FAILED — ${profileError.message}`);
    if (profileError.message.includes("permission denied")) {
      console.log("      -> missing GRANT for `authenticated`. Apply 20260729110000_p0_06_grants.sql");
    }
  } else if (!profile) {
    console.log("  [2] profile read: NO ROW — the app will bounce you back to /login");
    console.log("      -> the auth trigger did not create vizserve_pms_users. Run `npm run seed`.");
  } else {
    console.log(`  [2] profile: role=${profile.role} is_active=${profile.is_active}`);
    if (!profile.is_active) console.log("      -> inactive profiles are treated as no session");
    // ⚠️ `owner`, not `admin`. P8-01 retired `admin` to a dead rung that grants
    // nothing, so a row still holding it is NOT the wide-open account this line
    // used to describe — it is the narrowest one there is, and saying otherwise
    // here would send somebody debugging the wrong half of a lockout.
    if (profile.role !== "owner") console.log("      -> not an owner; nav and scope will be limited");
    if (profile.role === "admin") {
      console.log("      -> role is the RETIRED `admin` rung: it grants nothing. Promote to `owner`.");
    }
  }
}

// --- 3. ground truth via service role --------------------------------------
if (secret) {
  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listError) {
    console.log(`\n  [3] listUsers FAILED — ${listError.message}`);
  } else {
    const testUsers = list.users.filter((u) => u.email?.startsWith("test."));
    console.log(`\n  [3] auth.users with a "test." prefix: ${testUsers.length}`);
    for (const u of testUsers.slice(0, 5)) {
      console.log(
        `      ${u.email?.padEnd(38)} confirmed=${Boolean(u.email_confirmed_at)} providers=${u.app_metadata?.providers ?? "?"}`,
      );
    }
  }

  const { data: profiles, error: profilesError } = await admin
    .from("vizserve_pms_users")
    .select("email, role, is_active")
    .like("email", "test.%");

  if (profilesError) {
    console.log(`  [3] profiles FAILED — ${profilesError.message}`);
  } else {
    console.log(`  [3] vizserve_pms_users rows: ${profiles.length}`);
    for (const p of profiles.slice(0, 5)) {
      console.log(`      ${p.email.padEnd(38)} ${p.role.padEnd(12)} active=${p.is_active}`);
    }
  }
} else {
  console.log("\n  [3] skipped — SUPABASE_SECRET_KEY not set");
}

console.log("");

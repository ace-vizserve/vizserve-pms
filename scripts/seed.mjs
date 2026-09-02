#!/usr/bin/env node
/**
 * P0-12 — seed test accounts.
 *
 * Two safety rules from docs/04-phase-0-foundation.md, both load-bearing
 * because this system's whole purpose in Phase 4 is sending real mail to real
 * clients:
 *
 *   1. Every address is `@example.com` — an IANA-reserved domain that can never
 *      route to a real person. A seeded address one typo away from a real
 *      colleague's is how a QA run emails an actual client.
 *   2. Users are created through the admin API with `email_confirm: true`, so
 *      no confirmation mail is sent at all.
 *
 * Every account is prefixed `test.` so it is trivially selectable for deletion,
 * and a production smoke check asserts zero `@example.com` rows exist.
 *
 * Usage:  node scripts/seed.mjs
 * Needs:  SUPABASE_SECRET_KEY in .env (service role — bypasses RLS)
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
  console.error(
    "\n✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n\n" +
      "  The secret (service role) key bypasses RLS and is required to create\n" +
      "  auth users. Get it from:\n" +
      "    Supabase dashboard > Project Settings > API keys > secret\n\n" +
      "  Then add to .env:\n" +
      "    SUPABASE_SECRET_KEY=sb_secret_xxx\n",
  );
  process.exit(1);
}

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- fixtures -------------------------------------------------------------
const PASSWORD = "VizServe2026!dev";

const DEPARTMENTS = {
  VizBytes: "a1000000-0000-4000-8000-000000000001",
  VizAssists: "a1000000-0000-4000-8000-000000000002",
  VizBooks: "a1000000-0000-4000-8000-000000000003",
  VizMedia: "a1000000-0000-4000-8000-000000000004",
};

/**
 * Roles are inclusive (D15), so one role plus a managed-departments set covers
 * every real arrangement — including an admin who also approves for a
 * department, which is Amier's actual situation.
 *
 * Two members per department on purpose: Phase 2 sets both a PIC and a QA, and
 * Phase 3's QA gate is only meaningfully tested when they are different people.
 *
 * P7-32 — every spec carries a gender, ALTERNATED rather than chosen, because
 * these are fixtures and any pattern in them would be read as meaning something.
 * The admin form requires the field, so seeded accounts that lacked one would be
 * the only rows in the system that could not be saved without an extra choice —
 * which is a fixture behaving unlike the thing it stands in for.
 */
const USERS = [
  // ⚠️ `owner`, NOT `admin`. P8-01 moved "oversees everything" up to the new top
  // rung and left `admin` behind as a DEAD RUNG that grants nothing — every
  // predicate in the database now reads `>= owner`. Seeding this account as
  // `admin` produced an environment with ZERO owners: nobody could open
  // /admin/* or /hr/*, and every vizserve_pms_is_admin() policy denied
  // everybody. The email keeps its name because a dozen scripts and db tests
  // sign in with it; only the rank moved.
  { email: "test.admin@example.com", name: "Test Admin", role: "owner", gender: "MALE", dept: null, manages: [] },
  { email: "test.manager@example.com", name: "Test Manager", role: "manager", gender: "FEMALE", dept: null, manages: ["VizAssists", "VizBooks"] },
  { email: "test.manager.all@example.com", name: "Test Manager (All)", role: "manager", gender: "MALE", dept: null, manages: ["VizBytes", "VizAssists", "VizBooks", "VizMedia"] },

  { email: "test.tl.vizbytes@example.com", name: "TL VizBytes", role: "team_leader", gender: "FEMALE", dept: "VizBytes", manages: ["VizBytes"] },
  { email: "test.tl.vizassists@example.com", name: "TL VizAssists", role: "team_leader", gender: "MALE", dept: "VizAssists", manages: ["VizAssists"] },
  { email: "test.tl.vizbooks@example.com", name: "TL VizBooks", role: "team_leader", gender: "FEMALE", dept: "VizBooks", manages: ["VizBooks"] },
  { email: "test.tl.vizmedia@example.com", name: "TL VizMedia", role: "team_leader", gender: "MALE", dept: "VizMedia", manages: ["VizMedia"] },

  { email: "test.member1.vizbytes@example.com", name: "Member One VizBytes", role: "member", gender: "FEMALE", dept: "VizBytes", manages: [] },
  { email: "test.member2.vizbytes@example.com", name: "Member Two VizBytes", role: "member", gender: "MALE", dept: "VizBytes", manages: [] },
  { email: "test.member1.vizassists@example.com", name: "Member One VizAssists", role: "member", gender: "FEMALE", dept: "VizAssists", manages: [] },
  { email: "test.member2.vizassists@example.com", name: "Member Two VizAssists", role: "member", gender: "MALE", dept: "VizAssists", manages: [] },
  { email: "test.member1.vizbooks@example.com", name: "Member One VizBooks", role: "member", gender: "FEMALE", dept: "VizBooks", manages: [] },
  { email: "test.member2.vizbooks@example.com", name: "Member Two VizBooks", role: "member", gender: "MALE", dept: "VizBooks", manages: [] },
  { email: "test.member1.vizmedia@example.com", name: "Member One VizMedia", role: "member", gender: "FEMALE", dept: "VizMedia", manages: [] },
  { email: "test.member2.vizmedia@example.com", name: "Member Two VizMedia", role: "member", gender: "MALE", dept: "VizMedia", manages: [] },
];

// NOTE: test.client@example.com is deliberately NOT here. The Phase 4 approval
// flow is session-less by design, so the client exists only as a
// `requester_email` value. Give it a user row and the test stops testing the
// thing that ships.

async function findUserByEmail(email) {
  // listUsers is paginated; the seed set is small enough that one page does.
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

async function upsertUser(spec) {
  let authUser = await findUserByEmail(spec.email);

  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: spec.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: spec.name },
    });
    if (error) throw new Error(`createUser ${spec.email}: ${error.message}`);
    authUser = data.user;
  } else {
    // Keep the password predictable across re-runs.
    const { error } = await supabase.auth.admin.updateUserById(authUser.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`updateUser ${spec.email}: ${error.message}`);
  }

  // The auth trigger normally creates the profile row; upsert rather than
  // update so a missing row is created instead of silently matching zero rows
  // and reporting success.
  const { error: profileError } = await supabase.from("vizserve_pms_users").upsert(
    {
      id: authUser.id,
      email: spec.email,
      full_name: spec.name,
      gender: spec.gender,
      role: spec.role,
      primary_department_id: spec.dept ? DEPARTMENTS[spec.dept] : null,
      is_active: true,
    },
    { onConflict: "id" },
  );

  if (profileError) {
    if (profileError.message.includes("permission denied")) {
      throw new Error(
        `${spec.email}: permission denied on vizserve_pms_users.\n` +
          "    This is a missing GRANT, not RLS. Apply the migration\n" +
          "    supabase/migrations/20260729110000_p0_06_grants.sql and retry.",
      );
    }
    throw new Error(`profile ${spec.email}: ${profileError.message}`);
  }

  await supabase.from("vizserve_pms_user_managed_departments").delete().eq("user_id", authUser.id);

  if (spec.manages.length > 0) {
    const { error: mdError } = await supabase
      .from("vizserve_pms_user_managed_departments")
      .insert(spec.manages.map((d) => ({ user_id: authUser.id, department_id: DEPARTMENTS[d] })));
    if (mdError) throw new Error(`managed depts ${spec.email}: ${mdError.message}`);
  }

  return authUser.id;
}

async function main() {
  console.log(`\nSeeding ${USERS.length} test accounts into ${url}\n`);

  for (const spec of USERS) {
    const id = await upsertUser(spec);
    const scope = spec.manages.length > 0 ? ` manages ${spec.manages.join(", ")}` : "";
    console.log(`  ✓ ${spec.email.padEnd(38)} ${spec.role.padEnd(12)}${scope}`);
    void id;
  }

  console.log(`\nAll accounts use the password: ${PASSWORD}`);
  console.log("Sign in at /login with test.admin@example.com to see everything.\n");
}

main().catch((error) => {
  console.error(`\n✗ Seed failed: ${error.message}\n`);
  process.exit(1);
});

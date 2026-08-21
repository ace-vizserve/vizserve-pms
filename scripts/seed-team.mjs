#!/usr/bin/env node
/**
 * The REAL VizServe roster.
 *
 * Deliberately a separate script from `scripts/seed.mjs`, which seeds the 16
 * `test.*@example.com` fixtures. The two must not merge:
 *
 *   * `seed.mjs` promises in its own header that every address it writes is
 *     `@example.com` — an IANA-reserved domain that cannot route to a person.
 *     Its accounts are named in `tests/db/helpers.ts` and back roughly 150
 *     database assertions. Renaming or deleting them breaks the suite.
 *   * This script writes addresses that reach REAL INBOXES. That is the whole
 *     difference, and it is why it will not write without `--apply` and refuses
 *     an `@example.com` address outright.
 *
 * Neither script deletes anything. Both are idempotent upserts, so re-running
 * either is safe and keeps the password predictable.
 *
 * These are live addresses. The system is in dry-run until RESEND_API_KEY is
 * set (docs/13), which is the only reason seeding them is currently harmless —
 * configure Resend when you intend real people to receive real notifications,
 * not before.
 *
 * Usage:
 *   node scripts/seed-team.mjs            # dry run — prints the plan, writes nothing
 *   node scripts/seed-team.mjs --apply    # creates/updates the accounts
 *
 * Needs: SUPABASE_SECRET_KEY (service role — bypasses RLS, creates auth users)
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
const APPLY = process.argv.includes("--apply");

if (!url || !secret) {
  console.error(
    "\n✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n\n" +
      "  The secret (service role) key bypasses RLS and is required to create\n" +
      "  auth users. Supabase dashboard > Project Settings > API keys > secret\n",
  );
  process.exit(1);
}

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- roster ---------------------------------------------------------------

/**
 * The same password as the test fixtures, and the same for everybody — as
 * asked. It is a SHARED DEV PASSWORD, not a credential: anyone who knows one
 * account knows all twenty.
 *
 * Before this project holds anything real, each person should set their own
 * through the reset flow, or sign in through Entra and never hold a password
 * here at all.
 */
const PASSWORD = "VizServe2026!dev";

/** Fixed UUIDs from 20260729090500_p0_02_seed_departments.sql. */
const DEPARTMENTS = {
  VizBytes: "a1000000-0000-4000-8000-000000000001",
  VizAssists: "a1000000-0000-4000-8000-000000000002",
  VizBooks: "a1000000-0000-4000-8000-000000000003",
  VizMedia: "a1000000-0000-4000-8000-000000000004",
};

const ALL_DEPARTMENTS = Object.keys(DEPARTMENTS);

const DOMAIN = "vizserve.hfse.edu.sg";

/**
 * The name is already in the address: `first.last@…` → "First Last".
 *
 * Titlecased on the dot only. It does not try to split a run-together first
 * name — `johnlloyd.tulang` becomes "Johnlloyd Tulang", not "John Lloyd
 * Tulang", because guessing where a name divides is how you get "Ma Rie".
 * Anything needing a different rendering goes in NAME_OVERRIDES, where it is
 * visible rather than inferred.
 */
function nameFromEmail(email) {
  return email
    .split("@")[0]
    .split(".")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Addresses with no dot to split on. */
const NAME_OVERRIDES = {
  "manager@vizserve.com": "Manager (All)",
  "admin@vizserve.com": "Admin",
  // Uncomment if he spells it as two words — the rule above cannot know.
  // [`johnlloyd.tulang@${DOMAIN}`]: "John Lloyd Tulang",
};

/** A department's team leader plus its members, one line each. */
function team(department, lead, members) {
  return [
    {
      email: `${lead}@${DOMAIN}`,
      role: "team_leader",
      dept: department,
      // A TL's scope comes from the managed-departments rows, not from the
      // role. Leading one's own department is recorded here, not implied.
      manages: [department],
    },
    ...members.map((member) => ({
      email: `${member}@${DOMAIN}`,
      role: "member",
      dept: department,
      manages: [],
    })),
  ];
}

const ROSTER = [
  ...team("VizBytes", "amier.ordonez", ["ace.guevarra", "kurt.arciaga", "raiza.mondina"]),
  ...team("VizAssists", "joel.castro", [
    "joann.clemente",
    "rafael.bislinio",
    "louilyn.gutierrez",
    "alicia.layo",
  ]),
  ...team("VizMedia", "johnlloyd.tulang", [
    "kiervin.oliquino",
    "neri.lopez",
    "victoria.montesclaros",
  ]),
  ...team("VizBooks", "amy.castro", ["hazel.amoranto", "raechelle.mallari"]),

  // Managers over everything. No primary department — they do not sit in one,
  // they oversee all four, and `manages` is what actually grants that scope.
  { email: `nina.cacananta@${DOMAIN}`, role: "manager", dept: null, manages: ALL_DEPARTMENTS },
  { email: `gary.cacananta@${DOMAIN}`, role: "manager", dept: null, manages: ALL_DEPARTMENTS },
  { email: "manager@vizserve.com", role: "manager", dept: null, manages: ALL_DEPARTMENTS },

  // Roles are inclusive (D15), so an admin already outranks every department
  // check. No managed-department rows are needed to see everything.
  { email: "admin@vizserve.com", role: "admin", dept: null, manages: [] },
].map((spec) => ({ ...spec, name: NAME_OVERRIDES[spec.email] ?? nameFromEmail(spec.email) }));

// --- guards ---------------------------------------------------------------

const reserved = ROSTER.filter((spec) => spec.email.toLowerCase().endsWith("@example.com"));
if (reserved.length > 0) {
  console.error(
    "\n✗ This script is for real addresses. @example.com fixtures belong in" +
      " scripts/seed.mjs:\n" +
      reserved.map((spec) => `    ${spec.email}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

const duplicates = ROSTER.map((spec) => spec.email.toLowerCase()).filter(
  (email, index, all) => all.indexOf(email) !== index,
);
if (duplicates.length > 0) {
  console.error(`\n✗ Duplicate addresses in the roster: ${[...new Set(duplicates)].join(", ")}\n`);
  process.exit(1);
}

// --- write ----------------------------------------------------------------

async function findUserByEmail(email) {
  // listUsers is paginated; perPage covers this roster and the fixtures together.
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

async function upsertUser(spec) {
  let authUser = await findUserByEmail(spec.email);
  const existed = Boolean(authUser);

  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: spec.email,
      password: PASSWORD,
      // No confirmation mail is sent. On a roster of live addresses that is not
      // a convenience — it is the difference between seeding and spamming.
      email_confirm: true,
      user_metadata: { full_name: spec.name },
    });
    if (error) throw new Error(`createUser ${spec.email}: ${error.message}`);
    authUser = data.user;
  } else {
    const { error } = await supabase.auth.admin.updateUserById(authUser.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`updateUser ${spec.email}: ${error.message}`);
  }

  // Upsert rather than update: the auth trigger normally creates the profile
  // row, but an update against a missing one matches zero rows and still
  // reports success.
  const { error: profileError } = await supabase.from("vizserve_pms_users").upsert(
    {
      id: authUser.id,
      email: spec.email,
      full_name: spec.name,
      role: spec.role,
      primary_department_id: spec.dept ? DEPARTMENTS[spec.dept] : null,
      is_active: true,
      // Explicit rather than left to the column default, which applies only on
      // INSERT — an existing row would keep whatever it already had.
      app_access: ["vizserve-pms"],
    },
    { onConflict: "id" },
  );

  if (profileError) {
    if (profileError.message.includes("permission denied")) {
      throw new Error(
        `${spec.email}: permission denied on vizserve_pms_users.\n` +
          "    This is a missing GRANT, not RLS (docs/13). Apply\n" +
          "    supabase/migrations/20260729110000_p0_06_grants.sql and retry.",
      );
    }
    throw new Error(`profile ${spec.email}: ${profileError.message}`);
  }

  // Replaced wholesale so a department someone no longer leads goes away.
  // Scoped to this user, so it can never reach the test fixtures.
  await supabase.from("vizserve_pms_user_managed_departments").delete().eq("user_id", authUser.id);

  if (spec.manages.length > 0) {
    const { error: mdError } = await supabase
      .from("vizserve_pms_user_managed_departments")
      .insert(spec.manages.map((d) => ({ user_id: authUser.id, department_id: DEPARTMENTS[d] })));
    if (mdError) throw new Error(`managed depts ${spec.email}: ${mdError.message}`);
  }

  return existed ? "updated" : "created";
}

function describe(spec) {
  const scope =
    spec.manages.length === ALL_DEPARTMENTS.length
      ? "all departments"
      : spec.manages.length > 0
        ? `manages ${spec.manages.join(", ")}`
        : (spec.dept ?? "");
  return `  ${spec.email.padEnd(42)} ${spec.name.padEnd(24)} ${spec.role.padEnd(12)} ${scope}`;
}

async function main() {
  console.log(`\n${ROSTER.length} accounts for ${url}\n`);
  for (const spec of ROSTER) console.log(describe(spec));

  if (!APPLY) {
    console.log(
      "\nDRY RUN — nothing was written.\n" +
        "These are real, deliverable addresses, so the write is opt-in:\n\n" +
        "    npm run seed:team -- --apply\n",
    );
    return;
  }

  console.log("\nApplying…\n");
  let created = 0;
  let updated = 0;

  for (const spec of ROSTER) {
    const outcome = await upsertUser(spec);
    if (outcome === "created") created += 1;
    else updated += 1;
    console.log(`  ✓ ${outcome.padEnd(8)} ${spec.email}`);
  }

  console.log(`\n${created} created, ${updated} updated.`);
  console.log(`Every account uses the password: ${PASSWORD}`);
  console.log("The test.*@example.com fixtures are untouched.\n");
}

main().catch((error) => {
  console.error(`\n✗ Seed failed: ${error.message}\n`);
  process.exit(1);
});

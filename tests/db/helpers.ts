import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * P0-12 — harness for the scope suite.
 *
 * RLS cannot be unit tested. A policy is an expression over `auth.uid()`, so the
 * only honest test signs in as a real user and counts the rows that come back.
 * Everything here exists to make that cheap.
 *
 * Each client is built with the PUBLISHABLE key and a real session, exactly like
 * the browser. Using the secret key here would bypass RLS and the suite would
 * pass while asserting nothing — which is the specific way a security suite
 * rots.
 */

export const TEST_PASSWORD = "VizServe2026!dev";

/** Mirrors supabase/seed-dev.sql and scripts/seed.mjs. Fixed UUIDs by design. */
export const DEPARTMENTS = {
  VizBytes: "a1000000-0000-4000-8000-000000000001",
  VizAssists: "a1000000-0000-4000-8000-000000000002",
  VizBooks: "a1000000-0000-4000-8000-000000000003",
  VizMedia: "a1000000-0000-4000-8000-000000000004",
} as const;

export const ACCOUNTS = {
  admin: "test.admin@example.com",
  manager: "test.manager@example.com",
  managerAll: "test.manager.all@example.com",
  tlVizBytes: "test.tl.vizbytes@example.com",
  tlVizAssists: "test.tl.vizassists@example.com",
  tlVizBooks: "test.tl.vizbooks@example.com",
  tlVizMedia: "test.tl.vizmedia@example.com",
  member1VizBytes: "test.member1.vizbytes@example.com",
  member2VizBytes: "test.member2.vizbytes@example.com",
  member1VizAssists: "test.member1.vizassists@example.com",
  // Seeded like the rest. Exposed for `app-access.test.ts`, which revokes the
  // account it signs in as — so a second case in that file needs a second
  // account, or it is testing a user the previous case already locked out.
  member2VizAssists: "test.member2.vizassists@example.com",
  /**
   * VIZBOOKS IS THE QUIET DEPARTMENT, and that is why this one is here.
   *
   * `timesheet.test.ts` has to TRANSFER a member between departments to reach
   * the only state P7-17 leaves where somebody holds hours against a task they
   * cannot see. A transfer is a mutation of a shared row, vitest runs files in
   * parallel, and every other member account is signed in — or revoked — by
   * some other file. Nothing else touches a VizBooks member.
   */
  member2VizBooks: "test.member2.vizbooks@example.com",
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

/**
 * Whether the scope suite can run at all.
 *
 * The suite skips rather than fails without credentials, so `npm run verify`
 * works on a laptop with no `.env.local`. The reason gets printed — a suite that
 * skips silently reports green while proving nothing, which is worse than red.
 */
export const dbTestsEnabled = Boolean(url && publishableKey && secretKey);

export const skipReason = dbTestsEnabled
  ? ""
  : "SKIPPED: set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and " +
    "SUPABASE_SECRET_KEY in .env.local, then run `npm run seed`, to run the scope suite.";

/** Service-role client. Sets up fixtures; never used to make an assertion. */
export function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(url!, secretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Unauthenticated client — the `anon` role, which must hold no privileges. */
export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(url!, publishableKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type SignedInClient = {
  email: string;
  userId: string;
  client: SupabaseClient<Database>;
};

const sessionCache = new Map<string, SignedInClient>();

/**
 * Signs in one of the seeded accounts and caches the session for the run.
 *
 * Caching matters: without it a file that checks eight accounts makes eight
 * network round trips per test rather than per run, and the suite gets slow
 * enough that people stop running it.
 */
export async function signIn(account: AccountKey): Promise<SignedInClient> {
  const cached = sessionCache.get(account);
  if (cached) return cached;

  const email = ACCOUNTS[account];
  const client = createClient<Database>(url!, publishableKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });

  if (error || !data.user) {
    throw new Error(
      `Could not sign in as ${email}: ${error?.message ?? "no user returned"}.\n` +
        "  Run `npm run seed` first — the scope suite asserts against the 16 seeded accounts.",
    );
  }

  const signed: SignedInClient = { email, userId: data.user.id, client };
  sessionCache.set(account, signed);
  return signed;
}

/**
 * `permission denied` is a missing GRANT; zero rows is a working policy.
 *
 * These are different failures with different fixes, and the grants incident
 * (docs/13) happened because they were conflated. Every assertion below that
 * expects "no access" states which of the two it means.
 */
export function isPermissionDenied(error: { message?: string } | null): boolean {
  return Boolean(error?.message?.includes("permission denied"));
}

/**
 * The values a Postgres enum currently holds, read from PostgREST's own OpenAPI
 * description.
 *
 * ⚠️ THIS EXISTS BECAUSE THE OBVIOUS PROBE IS SILENTLY WRONG. The intuitive way
 * to ask whether an enum has gained a value is to filter on it:
 *
 *   .from("...").select("id").eq("request_type", "TIME_IN_CORRECTION")
 *
 * That does NOT error on an unknown label. PostgREST returns an empty result and
 * a null error, so the probe reports "migration applied" against a database
 * where the value does not exist — and the cases it guards then run and fail
 * with something unrelated. Measured against this project on 24 Aug 2026, not
 * assumed.
 *
 * A column probe is still the better guard where a migration adds one (see the
 * P7-04 and P7-12 probes in phase5.test.ts, and the reasoning there). This is
 * for the case where a migration adds an enum value and NO column, which
 * P7-38/P7-39 do.
 *
 * Returns an empty array if the spec cannot be read or the type is unknown —
 * a probe that throws at module load takes the whole file down with it, and the
 * honest failure mode is "skipped, loudly", not "collection error".
 */
export async function enumValues(table: string, column: string): Promise<string[]> {
  if (!url || !secretKey) return [];

  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
    });
    if (!response.ok) return [];

    const spec = (await response.json()) as {
      definitions?: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
    };

    return spec.definitions?.[table]?.properties?.[column]?.enum ?? [];
  } catch {
    return [];
  }
}

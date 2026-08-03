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

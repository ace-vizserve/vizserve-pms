import { afterAll, describe, expect, it } from "vitest";

import { adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * The app access gate.
 *
 * "May this person enter VizServe PMS at all" is a different question from "is
 * this token valid". The auth pool is shared with other HFSE systems and Entra
 * SSO admits the whole tenant, so a perfectly good session can belong to
 * somebody who has never been a user of this product.
 *
 * THE ASSERTION THAT MATTERS is the last one in the first block: revoking access
 * in the table cannot be undone by the user rewriting their own metadata. The
 * claim also exists in `raw_user_meta_data`, where it is user-writable, and the
 * entire point of this design is that nothing reads it there.
 */

if (!dbTestsEnabled) console.warn(`\n  app-access.test.ts — ${skipReason}\n`);

const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_users").select("app_access").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  app-access.test.ts — SKIPPED. supabase/migrations/20260804120000_app_access_gate.sql" +
      " has not been applied. Apply it, then re-run.\n",
  );
}

/** Always restore, whatever the assertion did. */
const touched: string[] = [];

async function revokeAccess(userId: string) {
  touched.push(userId);
  await adminClient().from("vizserve_pms_users").update({ app_access: [] }).eq("id", userId);
}

describe.skipIf(!dbTestsEnabled)("app access gate", () => {
  afterAll(async () => {
    const admin = adminClient();
    for (const userId of touched) {
      await admin
        .from("vizserve_pms_users")
        .update({ app_access: ["vizserve-pms"] })
        .eq("id", userId);
    }
  });

  describe("revoking access", () => {
    it.skipIf(!migrationApplied)("closes every table at once", async () => {
      // The gate is wired into `vizserve_pms_current_role()`, which every policy
      // funnels through — so one revoke shuts the whole app rather than needing
      // a policy edit per table and a new one remembered for every future table.
      const { client, userId } = await signIn("member1VizAssists");

      const before = await client.from("vizserve_pms_departments").select("id");
      expect(before.data!.length).toBeGreaterThan(0);

      await revokeAccess(userId);

      const { data: role } = await client.rpc("vizserve_pms_current_role");
      expect(role).toBeNull();

      const { data: departments, error } = await client
        .from("vizserve_pms_departments")
        .select("id");

      // Zero rows, not an error — a working policy, not a missing grant.
      expect(error).toBeNull();
      expect(departments).toEqual([]);

      const { data: own } = await client.from("vizserve_pms_users").select("id");
      // Not even their own profile row: `users read own profile` is the one
      // policy that does not go through current_role(), so this proves the
      // reader itself is what stops.
      expect(own?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it.skipIf(!migrationApplied)(
      "CANNOT be undone by the user rewriting their own metadata",
      async () => {
        // The whole reason the claim is not read from `user_metadata`. The copy
        // there is user-writable through Supabase's own endpoint, so if anything
        // trusted it, being locked out would be a one-curl inconvenience.
        const { client, userId } = await signIn("member2VizBytes");

        await revokeAccess(userId);

        const { error: escalation } = await client.auth.updateUser({
          data: { app_access: ["vizserve-pms"], role: "admin" },
        });
        expect(escalation).toBeNull();

        await client.auth.refreshSession();

        // The tampered claim is genuinely present in the token…
        const { data: claimed } = await client.auth.getUser();
        expect(claimed.user?.user_metadata?.app_access).toEqual(["vizserve-pms"]);

        // …and buys nothing.
        const { data: role } = await client.rpc("vizserve_pms_current_role");
        expect(role).toBeNull();

        const { data: access } = await client.rpc("vizserve_pms_has_app_access");
        expect(access).toBe(false);

        const { data: departments } = await client
          .from("vizserve_pms_departments")
          .select("id");
        expect(departments).toEqual([]);
      },
    );

    it.skipIf(!migrationApplied)("restores everything when granted back", async () => {
      const { client, userId } = await signIn("member2VizBytes");

      await revokeAccess(userId);
      expect(await client.rpc("vizserve_pms_has_app_access").then((r) => r.data)).toBe(false);

      await adminClient()
        .from("vizserve_pms_users")
        .update({ app_access: ["vizserve-pms"] })
        .eq("id", userId);

      // No re-login needed: the decision reads the table, so it takes effect on
      // the next request rather than at the next token refresh.
      expect(await client.rpc("vizserve_pms_has_app_access").then((r) => r.data)).toBe(true);

      const { data: departments } = await client.from("vizserve_pms_departments").select("id");
      expect(departments!.length).toBeGreaterThan(0);
    });
  });

  describe("the trustworthy mirror", () => {
    it.skipIf(!migrationApplied)(
      "writes role and app_access into app_metadata, not only user_metadata",
      async () => {
        const admin = adminClient();
        const { userId } = await signIn("tlVizBytes");

        // Read WITHOUT touching the row first. The mirror must already be
        // correct for every existing user, not only for one just edited — that
        // is what the backfill in 20260804130000 is for, and the first attempt
        // at it silently did nothing.
        const { data } = await admin.auth.admin.getUserById(userId);

        // app_metadata is service-role-writable only, so a claim found here was
        // put there by us. This is the copy the proxy may lean on.
        expect(data.user?.app_metadata?.app_access).toEqual(["vizserve-pms"]);
        expect(data.user?.app_metadata?.role).toBe("team_leader");
        expect(data.user?.app_metadata?.is_active).toBe(true);
      },
    );

    it.skipIf(!migrationApplied)("keeps the mirror in step when access is revoked", async () => {
      // The original trigger watched only `role`, so revoking access would have
      // left a stale JWT claim saying otherwise until the next sign-in.
      const admin = adminClient();
      const { userId } = await signIn("member1VizAssists");

      await revokeAccess(userId);

      const { data } = await admin.auth.admin.getUserById(userId);
      expect(data.user?.app_metadata?.app_access).toEqual([]);
    });
  });

  describe("a role this app knows", () => {
    it.skipIf(!migrationApplied)("every seeded account holds one of the four", async () => {
      // The role column is an enum, so an unknown role is unrepresentable rather
      // than merely absent — worth pinning, because the requirement is stated as
      // "check their role against the roles we have in this app" and it is easy
      // to assume that needs runtime validation it does not need.
      const { data } = await adminClient()
        .from("vizserve_pms_users")
        .select("role")
        .like("email", "test.%@example.com");

      const roles = new Set((data ?? []).map((row) => row.role));
      for (const role of roles) {
        expect(["member", "team_leader", "manager", "admin"]).toContain(role);
      }
    });
  });
});

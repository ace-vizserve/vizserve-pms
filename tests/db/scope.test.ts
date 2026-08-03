import { beforeAll, describe, expect, it } from "vitest";

import {
  ACCOUNTS,
  DEPARTMENTS,
  adminClient,
  anonClient,
  dbTestsEnabled,
  isPermissionDenied,
  signIn,
  skipReason,
} from "./helpers";

/**
 * P0-12 — THE SCOPE SUITE. This is the Phase 0 exit criterion.
 *
 * Phase 0 says scope must be "verified by test, not by clicking around", and
 * this is that test. Every assertion below is a row count against a live
 * database as a really signed-in user, because that is the only thing that
 * proves an RLS policy.
 *
 * Read `skipReason` if this whole file skips.
 */

if (!dbTestsEnabled) console.warn(`\n  scope.test.ts — ${skipReason}\n`);

describe.skipIf(!dbTestsEnabled)("P0-12 scope suite", () => {
  beforeAll(async () => {
    // Fail loudly and early if the fixtures are missing, rather than letting
    // every assertion below fail with a confusing zero-rows result that looks
    // like a policy bug.
    //
    // Checked by name rather than by count: the count is the thing that drifts
    // when someone adds a seed account, and "expected 16, found 17" is a useless
    // failure. What these tests actually need is that THESE accounts exist.
    const { data, error } = await adminClient()
      .from("vizserve_pms_users")
      .select("email")
      .like("email", "test.%@example.com");

    if (error) {
      throw new Error(
        `Cannot read seeded users: ${error.message}\n` +
          (isPermissionDenied(error)
            ? "  That is a missing GRANT, not RLS. Apply 20260729110000_p0_06_grants.sql."
            : ""),
      );
    }

    const present = new Set((data ?? []).map((row) => row.email.toLowerCase()));
    const missing = Object.values(ACCOUNTS).filter((email) => !present.has(email));

    if (missing.length > 0) {
      throw new Error(
        `Missing seeded accounts: ${missing.join(", ")}.\n  Run \`npm run seed\`.`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // anon holds nothing at all
  // -------------------------------------------------------------------------
  describe("anon", () => {
    it("has no privilege on any table — permission denied, not empty", () => {
      return anonClient()
        .from("vizserve_pms_users")
        .select("id")
        .then(({ error }) => {
          // Deliberately asserting DENIED rather than empty. anon has no GRANT
          // at all (20260729110000), so this must not merely return zero rows —
          // zero rows would mean a policy is doing the work and a future
          // permissive policy could open it.
          expect(error).not.toBeNull();
          expect(isPermissionDenied(error)).toBe(true);
        });
    });

    it("cannot read requests", async () => {
      const { error } = await anonClient().from("vizserve_pms_requests").select("id");
      expect(isPermissionDenied(error)).toBe(true);
    });

    it("cannot read audit logs", async () => {
      const { error } = await anonClient().from("vizserve_pms_audit_logs").select("id");
      expect(isPermissionDenied(error)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Users table — the core scope assertion
  // -------------------------------------------------------------------------
  describe("vizserve_pms_users visibility", () => {
    it("a member sees exactly one row — their own", async () => {
      const { client, userId } = await signIn("member1VizBytes");
      const { data, error } = await client.from("vizserve_pms_users").select("id, email");

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data![0]!.id).toBe(userId);
    });

    it("a member sees zero rows for a colleague, not an error", async () => {
      // The distinction the grants incident turned on: a failing POLICY returns
      // zero rows; a missing GRANT says permission denied. This must be the
      // former.
      const { client } = await signIn("member1VizBytes");
      const { data, error } = await client
        .from("vizserve_pms_users")
        .select("id")
        .eq("email", ACCOUNTS.member2VizBytes);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("a TL sees their own department and not another", async () => {
      const { client } = await signIn("tlVizBytes");
      const { data, error } = await client
        .from("vizserve_pms_users")
        .select("id, email, primary_department_id");

      expect(error).toBeNull();

      const departments = new Set(
        data!.map((row) => row.primary_department_id).filter(Boolean) as string[],
      );
      expect([...departments]).toEqual([DEPARTMENTS.VizBytes]);

      const emails = data!.map((row) => row.email.toLowerCase());
      expect(emails).toContain(ACCOUNTS.member1VizBytes);
      expect(emails).not.toContain(ACCOUNTS.member1VizAssists);
    });

    it("a manager of two departments sees exactly two departments' worth", async () => {
      // Verbatim from the Phase 0 exit criteria.
      const { client } = await signIn("manager");
      const { data, error } = await client
        .from("vizserve_pms_users")
        .select("id, primary_department_id");

      expect(error).toBeNull();

      const departments = new Set(
        data!.map((row) => row.primary_department_id).filter(Boolean) as string[],
      );
      expect([...departments].sort()).toEqual(
        [DEPARTMENTS.VizAssists, DEPARTMENTS.VizBooks].sort(),
      );
      expect(departments.has(DEPARTMENTS.VizBytes)).toBe(false);
    });

    it("an admin sees every seeded account, across all four departments", async () => {
      const { client } = await signIn("admin");

      const { data, error } = await client
        .from("vizserve_pms_users")
        .select("email, primary_department_id")
        .like("email", "test.%@example.com");

      expect(error).toBeNull();

      // Compared against what the service role can see rather than a hardcoded
      // count, so adding a seed account does not fail this test for no reason.
      const { data: all } = await adminClient()
        .from("vizserve_pms_users")
        .select("email")
        .like("email", "test.%@example.com");

      expect(data!.length).toBe(all!.length);

      const departments = new Set(
        data!.map((row) => row.primary_department_id).filter(Boolean) as string[],
      );
      expect(departments.size).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // THE ONE THAT MATTERS MOST (D18)
  // -------------------------------------------------------------------------
  describe("user_metadata is not trusted anywhere in the authorization path", () => {
    it("a member who rewrites their own metadata role to admin still sees only their own row", async () => {
      // `user_metadata` is writable by the user through Supabase's own GoTrue
      // endpoint. If any policy or server check read it, this would be a silent
      // full privilege escalation with no audit trail. The whole D18 rule and
      // `npm run check:metadata` exist for this single test.
      const { client, userId } = await signIn("member2VizBytes");

      const { error: escalationError } = await client.auth.updateUser({
        data: { role: "admin", app_access: ["vizserve-pms"] },
      });
      expect(escalationError).toBeNull();

      try {
        // Force a fresh token so the tampered claim is definitely in play.
        await client.auth.refreshSession();

        const { data: claimed } = await client.auth.getUser();
        expect(claimed.user?.user_metadata?.role).toBe("admin");

        const { data, error } = await client.from("vizserve_pms_users").select("id");
        expect(error).toBeNull();
        expect(data).toHaveLength(1);
        expect(data![0]!.id).toBe(userId);

        // And it buys nothing on the audit log either.
        const { data: auditRows } = await client
          .from("vizserve_pms_audit_logs")
          .select("id")
          .limit(5);
        expect(auditRows).toEqual([]);

        // The table — the actual source of truth — is untouched.
        const { data: profile } = await adminClient()
          .from("vizserve_pms_users")
          .select("role")
          .eq("id", userId)
          .single();
        expect(profile!.role).toBe("member");
      } finally {
        // Restore, so a re-run starts from a clean claim.
        await client.auth.updateUser({
          data: { role: "member", app_access: ["vizserve-pms"] },
        });
        await client.auth.refreshSession();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------
  describe("write scope", () => {
    it("a member cannot promote themselves in vizserve_pms_users", async () => {
      const { client, userId } = await signIn("member1VizBytes");

      await client.from("vizserve_pms_users").update({ role: "admin" }).eq("id", userId);

      // The update may report success having matched zero rows — RLS filters the
      // rows an UPDATE can see. What matters is the stored value, checked with
      // the service role so no policy can hide the answer.
      const { data } = await adminClient()
        .from("vizserve_pms_users")
        .select("role")
        .eq("id", userId)
        .single();

      expect(data!.role).toBe("member");
    });

    it("a TL cannot promote a member in a department they lead", async () => {
      // Leading a department is scope over its work, not over its people.
      // User administration is admin-only (P0-04).
      const { client } = await signIn("tlVizBytes");
      const { data: target } = await adminClient()
        .from("vizserve_pms_users")
        .select("id")
        .eq("email", ACCOUNTS.member1VizBytes)
        .single();

      await client
        .from("vizserve_pms_users")
        .update({ role: "team_leader" })
        .eq("id", target!.id);

      const { data } = await adminClient()
        .from("vizserve_pms_users")
        .select("role")
        .eq("id", target!.id)
        .single();

      expect(data!.role).toBe("member");
    });

    it("a member cannot grant themselves a managed department", async () => {
      // The managed set IS the scope. If a member can insert into it, every
      // department policy in the system is decorative.
      const { client, userId } = await signIn("member1VizBytes");

      await client
        .from("vizserve_pms_user_managed_departments")
        .insert({ user_id: userId, department_id: DEPARTMENTS.VizMedia });

      const { data } = await adminClient()
        .from("vizserve_pms_user_managed_departments")
        .select("department_id")
        .eq("user_id", userId);

      expect(data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Notifications — strictly your own inbox
  // -------------------------------------------------------------------------
  describe("notifications", () => {
    it("a user sees their own notifications and nobody else's", async () => {
      const admin = adminClient();
      const mine = await signIn("member1VizBytes");
      const theirs = await signIn("member2VizBytes");

      const { data: inserted, error: insertError } = await admin
        .from("vizserve_pms_notifications")
        .insert([
          {
            user_id: mine.userId,
            type: "status_changed",
            title: "P0-12 fixture — mine",
          },
          {
            user_id: theirs.userId,
            type: "status_changed",
            title: "P0-12 fixture — theirs",
          },
        ])
        .select("id, user_id");

      expect(insertError).toBeNull();

      try {
        const { data, error } = await mine.client
          .from("vizserve_pms_notifications")
          .select("id, user_id, title")
          .like("title", "P0-12 fixture%");

        expect(error).toBeNull();
        expect(data).toHaveLength(1);
        expect(data![0]!.user_id).toBe(mine.userId);
      } finally {
        await admin
          .from("vizserve_pms_notifications")
          .delete()
          .in("id", (inserted ?? []).map((row) => row.id));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Audit log — admin-read, function-write
  // -------------------------------------------------------------------------
  describe("audit logs", () => {
    it("a member reads zero audit rows", async () => {
      const { client } = await signIn("member1VizBytes");
      const { data, error } = await client.from("vizserve_pms_audit_logs").select("id").limit(5);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("a TL reads zero audit rows — the log is admin-only", async () => {
      const { client } = await signIn("tlVizBytes");
      const { data, error } = await client.from("vizserve_pms_audit_logs").select("id").limit(5);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("nobody can insert an audit row directly, admin included", async () => {
      // There is NO insert policy on purpose. Entries arrive only through the
      // SECURITY DEFINER writer, so an actor cannot forge or suppress their own
      // trail.
      const { client, userId } = await signIn("admin");

      const { error } = await client.from("vizserve_pms_audit_logs").insert({
        entity_type: "request",
        entity_id: userId,
        action: "forged",
      });

      expect(error).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Deactivation is a real gate
  // -------------------------------------------------------------------------
  describe("deactivation", () => {
    it("a deactivated user resolves to no role and therefore sees nothing", async () => {
      // `vizserve_pms_current_role()` returns null for an inactive profile, and
      // null fails every `>=` comparison. Worth asserting rather than assuming:
      // it is the difference between disabling an account and merely hiding it.
      const admin = adminClient();
      const { client, userId } = await signIn("member1VizAssists");

      await admin.from("vizserve_pms_users").update({ is_active: false }).eq("id", userId);

      try {
        const { data: role } = await client.rpc("vizserve_pms_current_role");
        expect(role).toBeNull();

        const { data: departments } = await client
          .from("vizserve_pms_departments")
          .select("id");
        expect(departments).toEqual([]);
      } finally {
        await admin.from("vizserve_pms_users").update({ is_active: true }).eq("id", userId);
      }
    });
  });
});

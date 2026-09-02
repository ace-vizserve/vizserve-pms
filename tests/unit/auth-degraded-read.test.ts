import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P8-01 — THE PROFILE READ MUST SURVIVE A MIGRATION THAT HAS NOT LANDED YET.
 *
 * ⚠️ THE FAILURE THIS FILE EXISTS FOR IS A TOTAL OUTAGE, NOT A DEAD FEATURE.
 *
 * Migrations in this repo are applied BY HAND, in the Supabase SQL editor, AFTER
 * the code is deployed (CLAUDE.md; docs/13-implementation-status.md). So there
 * is a real window in which `resolveAuth` is live and `p8_01b` has not been
 * pasted. In that window a select naming `is_dept_admin` is rejected WHOLE —
 * PostgREST returns no row — and if the read denied on that, `resolveAuth` would
 * answer `not_provisioned` to EVERY signed-in person, including the owner who
 * would have pasted the migration. There is no route back in through the app.
 *
 * These cases pin the three answers that matter and the line between them:
 *
 *   1. missing column      -> a working context, with `isDeptAdmin: false`
 *   2. genuinely no row    -> `not_provisioned`, exactly as before
 *   3. any other failure   -> `not_provisioned`, exactly as before
 *
 * (3) is the half that is easy to lose while fixing (1). A degrade that swallows
 * every error would be a worse bug than the lockout it replaced.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001";
const DEPT_A = "d1000000-0000-4000-8000-00000000000a";

type FakeError = { code: string; message: string } | null;

type FakeConfig = {
  /** null = no session at all. */
  user: { id: string } | null;
  /** The profile row the database would return, before any column is dropped. */
  profile: Record<string, unknown> | null;
  /**
   * What the FIRST read — the one naming `is_dept_admin` — fails with. `null`
   * means the column is there and the read succeeds.
   */
  firstError: FakeError;
};

let config: FakeConfig;

/** Every `select(...)` string the fake was asked for, in order. */
let selects: string[] = [];

/**
 * The narrowest fake that can tell the two reads apart.
 *
 * `.select()` records what was asked for and returns a thenable, so the same
 * object serves `await …eq().maybeSingle()` (the profile read) and
 * `await …eq()` (the managed-departments read, which has no `.maybeSingle()`).
 */
function makeClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: config.user } }),
    },
    from(table: string) {
      return {
        select(columns: string) {
          selects.push(columns);

          const wantsDeptAdmin = columns.includes("is_dept_admin");

          const query = {
            eq: () => query,
            maybeSingle: async () => {
              if (config.firstError && wantsDeptAdmin) {
                // PostgREST rejects the WHOLE select, not the column: no row.
                return { data: null, error: config.firstError };
              }

              if (!config.profile) return { data: null, error: null };

              const row = { ...config.profile };
              if (!wantsDeptAdmin) delete row.is_dept_admin;
              return { data: row, error: null };
            },
            // The managed-departments read is awaited directly.
            then: (resolve: (value: unknown) => unknown) =>
              resolve({ data: table.endsWith("managed_departments") ? [] : [], error: null }),
          };

          return query;
        },
      };
    },
  };
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => makeClient(),
}));

import { APP_ACCESS_KEY } from "@/lib/auth/app-access";
import { deptAdminColumnMissing, resolveAuth } from "@/lib/auth/authorization";

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: "test.owner@example.com",
    full_name: "Test Owner",
    gender: null,
    role: "owner",
    is_hr: false,
    is_dept_admin: true,
    primary_department_id: DEPT_A,
    is_active: true,
    app_access: [APP_ACCESS_KEY],
    ...overrides,
  };
}

beforeEach(() => {
  selects = [];
  config = { user: { id: USER_ID }, profile: profileRow(), firstError: null };
});

describe("deptAdminColumnMissing — the detection, and how narrow it is", () => {
  it("recognises the undefined_column error PostgREST forwards", () => {
    expect(
      deptAdminColumnMissing({
        code: "42703",
        message: "column vizserve_pms_users.is_dept_admin does not exist",
      }),
    ).toBe(true);
  });

  it("recognises the stale-schema-cache answer as well", () => {
    // The other half PostgREST can answer with while its own cache is behind.
    expect(
      deptAdminColumnMissing({
        code: "PGRST204",
        message: "Could not find the 'is_dept_admin' column of 'vizserve_pms_users' in the schema cache",
      }),
    ).toBe(true);
  });

  it("⚠️ REFUSES a 42703 about some OTHER column", () => {
    // The column name has to appear. Otherwise a future edit of the select that
    // named a genuinely wrong column would be silently degraded instead of
    // failing loudly, and the missing column would never be noticed.
    expect(
      deptAdminColumnMissing({
        code: "42703",
        message: "column vizserve_pms_users.is_hr does not exist",
      }),
    ).toBe(false);
  });

  it("⚠️ REFUSES an RLS refusal, a network fault, and no error at all", () => {
    // The heart of it: this is "the column is not there yet", NOT "the read
    // failed". Everything else must keep denying.
    expect(deptAdminColumnMissing(null)).toBe(false);
    expect(deptAdminColumnMissing({ code: "42501", message: "permission denied for table vizserve_pms_users" })).toBe(
      false,
    );
    expect(deptAdminColumnMissing({ code: "", message: "fetch failed" })).toBe(false);
    expect(deptAdminColumnMissing({ code: "PGRST301", message: "JWT expired" })).toBe(false);
  });
});

describe("resolveAuth — degrades rather than locking the company out", () => {
  it("resolves a full context when the column IS there", () => {
    // The baseline, so the degrade below is visibly a fallback rather than the
    // only path being exercised.
    return resolveAuth().then((result) => {
      expect(result.context).not.toBeNull();
      expect(result.context?.isDeptAdmin).toBe(true);
      expect(selects.filter((s) => s.includes("is_dept_admin"))).toHaveLength(1);
    });
  });

  it("⚠️ still resolves — with isDeptAdmin FALSE — when p8_01b has not been pasted", async () => {
    config.firstError = {
      code: "42703",
      message: "column vizserve_pms_users.is_dept_admin does not exist",
    };

    const result = await resolveAuth();

    // The whole point: a context, not a denial. Deny here and every signed-in
    // person is locked out of a live app, owner included.
    expect(result.context).not.toBeNull();
    expect(result.context?.role).toBe("owner");
    // ⚠️ FALSE IS THE ONLY SAFE ANSWER, and it cannot be anything else: the
    // column does not exist, so nobody holds the capability, and no policy
    // consults it either. The degrade can never GRANT.
    expect(result.context?.isDeptAdmin).toBe(false);
  });

  it("re-asks WITHOUT the column rather than inventing a row", async () => {
    config.firstError = {
      code: "42703",
      message: "column vizserve_pms_users.is_dept_admin does not exist",
    };

    await resolveAuth();

    const profileSelects = selects.filter((s) => s.includes("full_name"));
    expect(profileSelects).toHaveLength(2);
    expect(profileSelects[0]).toContain("is_dept_admin");
    expect(profileSelects[1]).not.toContain("is_dept_admin");
  });

  it("⚠️ still says not_provisioned when there is genuinely NO PROFILE ROW", async () => {
    // The half that must not be lost while fixing the lockout. `maybeSingle`
    // reports no error for zero rows, so this never reaches the degrade at all
    // — but a version that degraded on "no data" instead of "this error" would
    // hand a context to every stranger the shared auth pool admits.
    config.profile = null;

    const result = await resolveAuth();

    expect(result.context).toBeNull();
    expect(result).toMatchObject({ denial: "not_provisioned" });
  });

  it("still says not_provisioned when the row is missing AND the column is too", async () => {
    // Both at once: the fallback re-asks the same question and gets the same
    // answer — nobody there. It must not manufacture a profile out of the retry.
    config.profile = null;
    config.firstError = {
      code: "42703",
      message: "column vizserve_pms_users.is_dept_admin does not exist",
    };

    const result = await resolveAuth();

    expect(result.context).toBeNull();
    expect(result).toMatchObject({ denial: "not_provisioned" });
  });

  it("⚠️ still DENIES on an unrelated read failure", async () => {
    // An RLS refusal or a network fault is not a missing column, and answering
    // it with a context would be a real privilege bug rather than a degrade.
    config.firstError = { code: "42501", message: "permission denied for table vizserve_pms_users" };
    config.profile = profileRow();

    const result = await resolveAuth();

    expect(result.context).toBeNull();
    expect(result).toMatchObject({ denial: "not_provisioned" });
    // And it did NOT retry: one read, one answer.
    expect(selects.filter((s) => s.includes("full_name"))).toHaveLength(1);
  });

  it("keeps the deactivated and no-app-access gates while degraded", async () => {
    // The degrade touches ONE column. Every other gate still runs on the
    // fallback row, because it is the same row read a second time.
    config.firstError = {
      code: "42703",
      message: "column vizserve_pms_users.is_dept_admin does not exist",
    };

    config.profile = profileRow({ is_active: false });
    expect(await resolveAuth()).toMatchObject({ context: null, denial: "deactivated" });

    selects = [];
    config.profile = profileRow({ app_access: [] });
    expect(await resolveAuth()).toMatchObject({ context: null, denial: "no_app_access" });
  });

  it("says no_session before it reads anything at all", async () => {
    config.user = null;

    expect(await resolveAuth()).toMatchObject({ context: null, denial: "no_session" });
    expect(selects).toHaveLength(0);
  });
});

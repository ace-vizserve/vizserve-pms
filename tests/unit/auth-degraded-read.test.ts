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
/** P13-01 — a collaboration space. Nobody belongs to it; everybody acts in it. */
const SHARED_DEPT = "a1000000-0000-4000-8000-000000000005";

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
  /**
   * P13-01 — what the SHARED-DEPARTMENTS read fails with, independently of the
   * profile read.
   *
   * ⚠️ THIS IS THE WHOLE REASON THAT READ IS A QUERY OF ITS OWN. `is_shared`
   * does not exist until the migration is pasted, and the window between the
   * deploy and the paste is the one this file exists for. On the profile select
   * the column would take the entire request down with it and answer
   * `not_provisioned` to everybody; on its own, it answers "there are no
   * collaboration spaces", which is precisely true at that moment.
   */
  sharedError: FakeError;
  /** The shared departments the database would return when the column is there. */
  sharedRows: { id: string }[];
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
      /*
       * ⚠️ `getClaims`, not `getUser`. `resolveAuth` verifies the JWT locally
       * rather than asking the Auth server to resolve it — same guarantee, no
       * network — and `claims.sub` is the id that `user.id` used to be.
       *
       * The fixture still carries a `user` so these cases read the way they
       * always have; only the shape handed back changed.
       */
      getClaims: async () =>
        config.user
          ? { data: { claims: { sub: config.user.id } }, error: null }
          : { data: null, error: null },
    },
    from(table: string) {
      return {
        select(columns: string) {
          selects.push(columns);

          const wantsDeptAdmin = columns.includes("is_dept_admin");

          // P13-01. The departments read is the only one that orders, and it
          // is the only one on this table.
          const isShared = table.endsWith("_departments") && !table.includes("managed");

          const query = {
            eq: () => query,
            order: () => query,
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
            // The managed-departments and shared-departments reads are both
            // awaited directly.
            then: (resolve: (value: unknown) => unknown) => {
              if (isShared) {
                return resolve(
                  config.sharedError
                    ? { data: null, error: config.sharedError }
                    : { data: config.sharedRows, error: null },
                );
              }
              return resolve({ data: [], error: null });
            },
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
  config = {
    user: { id: USER_ID },
    profile: profileRow(),
    firstError: null,
    sharedError: null,
    sharedRows: [],
  };
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

/**
 * P13-01 — THE SHARED-DEPARTMENTS READ FAILS ALONE, OR IT IS THE SAME OUTAGE.
 *
 * `is_shared` is a column that does not exist until the migration is pasted by
 * hand, which is exactly the situation the rest of this file is about. The
 * decision was to ask for it in a query of its OWN rather than on the profile
 * select, and these cases are what hold that decision in place: they fail if
 * somebody "tidies" the third read into the first.
 *
 * The degrade GRANTS something, unlike `must_change_password`, so the safe
 * direction had to be proved rather than assumed. Empty means "there are no
 * collaboration spaces", which is the truth before the migration lands: the
 * flag does not exist, nothing is flagged, and no policy admits anybody
 * anywhere new. The failure direction is "the space is not there yet", never
 * "everybody is in everything".
 */
describe("resolveAuth — the collaboration spaces ride along without risking the session", () => {
  it("carries the shared departments onto the context", async () => {
    config.sharedRows = [{ id: SHARED_DEPT }];

    const result = await resolveAuth();

    expect(result.context?.sharedDepartmentIds).toEqual([SHARED_DEPT]);
  });

  it("⚠️ still signs the person in when `is_shared` does not exist yet", async () => {
    config.sharedError = {
      code: "42703",
      message: "column vizserve_pms_departments.is_shared does not exist",
    };

    const result = await resolveAuth();

    // The session is INTACT. This is the assertion that matters: on the profile
    // select the same error would have answered `not_provisioned` to everybody.
    expect(result.context).not.toBeNull();
    expect(result.context?.userId).toBe(USER_ID);
    // And the feature is simply absent, which is what is true at that moment.
    expect(result.context?.sharedDepartmentIds).toEqual([]);
  });

  it("⚠️ degrades to empty on ANY failure of that read, not only a missing column", async () => {
    // There is no narrow error matcher here and there must not be one. The read
    // only ever ADDS a department nobody leads; treating every failure as "none"
    // cannot lock anybody out and cannot let anybody in.
    config.sharedError = { code: "PGRST301", message: "JWT expired" };

    const result = await resolveAuth();

    expect(result.context).not.toBeNull();
    expect(result.context?.sharedDepartmentIds).toEqual([]);
  });

  it("does not resurrect a denied session", async () => {
    // A shared space is not app access. Somebody deactivated is still out, and
    // the read that succeeded above cannot change that.
    config.sharedRows = [{ id: SHARED_DEPT }];
    config.profile = profileRow({ is_active: false });

    expect(await resolveAuth()).toMatchObject({ context: null, denial: "deactivated" });
  });
});

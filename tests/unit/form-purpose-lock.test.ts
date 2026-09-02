import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SLA_MINUTES } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 4b — ⚠️⚠️ THE PURPOSE LOCK COUNTS STAFF RESPONSES TOO.
 *
 * THE BUG THIS PINS, in full, because it is the most damaging one this ticket
 * could have shipped:
 *
 *   `updateFormSettings` refuses to change a form's `purpose` once the form has
 *   submissions. The count was `vizserve_pms_requests` and nothing else — and
 *   an INTERNAL form NEVER produces a request. Its answers go to
 *   `vizserve_pms_form_responses`, the table 4b creates.
 *
 *   So the moment that table existed, a pulse survey with a thousand staff
 *   answers behind it still counted ZERO. The lock never engaged. A team leader
 *   could flip the form to CLIENT_REQUEST, whereupon the applied CHECK
 *   `is_public = (purpose = 'CLIENT_REQUEST')` sets `is_public` true, and
 *   `vizserve_pms_get_public_form` — whose where clause is
 *   `slug and is_public and is_active`, and which has never heard of `purpose`
 *   — serves that form at /request/<slug> to anybody with the URL. No session.
 *
 * ⚠️ THE SECOND HALF OF THE DEFENCE IS `formSettingsSchema` REQUIRING
 * `purpose`, tested in `form-purpose.test.ts`. That one stops a payload
 * SAYING NOTHING. This one stops a payload saying CLIENT_REQUEST out loud.
 * Neither replaces the other, and neither may be weakened.
 *
 * This is a UNIT test of a server action, which is unusual here and is the
 * point: the rule lives in the action, not in a pure function, and a rule with
 * no test is a rule until somebody refactors it. Supabase is faked at the
 * module boundary — no network, no database, no live production.
 */

// ---------------------------------------------------------------------------
// The fake Supabase clients — TWO OF THEM, and that is as much the point of
// this file now as the counting is.
//
// They answer exactly the four calls `updateFormSettings` makes and record what
// each one was asked, so a test can assert on the QUESTION as well as the
// answer — "did it count the responses table at all" is the whole point here,
// and a client that returned the right number for the wrong reason would pass a
// test that only looked at the outcome.
//
// ⚠️ THE CALLER'S RLS CLIENT REFUSES TO COUNT. `recorder.countedViaCaller`
// records any count taken through it, because a count read through a policy
// that can legitimately exclude the reader is the second bug this file pins:
// both count policies are `manages_department(form.department_id)`, which is
// FALSE for a team leader on an UNROUTED form, so the caller's client returned
// zero AND NO ERROR and the lock silently never engaged. See
// `countFormSubmissions`.
// ---------------------------------------------------------------------------

type CountAnswer = { count?: number; error?: { message: string } };

type FakeConfig = {
  form: {
    id: string;
    department_id: string | null;
    created_by: string | null;
    reference_prefix: string;
    purpose: "CLIENT_REQUEST" | "INTERNAL";
    is_anonymous: boolean;
  };
  requests?: CountAnswer;
  responses?: CountAnswer;
  updateError?: { message: string; code?: string };
};

type Recorder = {
  /** Every table counted through the SERVICE-ROLE client, in call order. */
  counted: string[];
  /**
   * Every table counted through the CALLER's RLS client. ⚠️ MUST STAY EMPTY —
   * a count taken there is the under-count that reopens the purpose hole.
   */
  countedViaCaller: string[];
  /** Every payload handed to `.update()`. Empty means nothing was written. */
  updates: Record<string, unknown>[];
};

function makeFakeClient(config: FakeConfig) {
  const recorder: Recorder = { counted: [], countedViaCaller: [], updates: [] };

  const answerFor = (table: string): CountAnswer => {
    if (table === "vizserve_pms_requests") return config.requests ?? { count: 0 };
    if (table === "vizserve_pms_form_responses") return config.responses ?? { count: 0 };
    throw new Error(`the fake client was asked to count ${table}`);
  };

  function makeClient(via: "service_role" | "caller") {
    return {
      from(table: string) {
        // A single chainable object. `.eq()` returns itself, `.maybeSingle()`
        // resolves the row read, and `then` makes the builder itself awaitable
        // — which is how `select(..., { head: true })` and `update()` are
        // consumed.
        let resolved: Promise<unknown> = Promise.resolve({ error: null });

        const chain = {
          select(columns: string, options?: { count?: string; head?: boolean }) {
            void columns;
            if (!options?.head) return chain;

            if (via === "caller") {
              // Recorded and REFUSED. The real failure mode is worse than an
              // error — zero rows and no error at all — so the assertion that
              // matters is on `countedViaCaller`, not on the outcome.
              recorder.countedViaCaller.push(table);
              resolved = Promise.resolve({
                count: null,
                error: { message: "counted through the caller's RLS client" },
              });
              return chain;
            }

            recorder.counted.push(table);
            const answer = answerFor(table);
            resolved = Promise.resolve({
              count: answer.count ?? null,
              error: answer.error ?? null,
            });
            return chain;
          },
          update(values: Record<string, unknown>) {
            recorder.updates.push(values);
            resolved = Promise.resolve({ error: config.updateError ?? null });
            return chain;
          },
          eq() {
            return chain;
          },
          maybeSingle() {
            return Promise.resolve({ data: config.form, error: null });
          },
          then(
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) {
            return resolved.then(onFulfilled, onRejected);
          },
        };

        return chain;
      },
    };
  }

  return { client: makeClient("caller"), admin: makeClient("service_role"), recorder };
}

let fake = makeFakeClient({
  form: {
    id: "form-1",
    department_id: "dept-1",
    created_by: "user-1",
    reference_prefix: "PUL",
    purpose: "INTERNAL",
    is_anonymous: false,
  },
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => fake.client,
}));

/**
 * ⚠️ THE SERVICE-ROLE CLIENT IS A SEPARATE FAKE, so "which client counted" is
 * observable at all. `countFormSubmissions` constructs it itself rather than
 * accepting one, precisely so no caller can hand it an RLS-scoped client and
 * quietly reopen the under-count.
 */
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => fake.admin,
}));

/**
 * Authorization is stubbed to ALLOW, deliberately.
 *
 * The thing under test is what happens to somebody who is already permitted to
 * edit this form — a team leader of its department. A stub that refused would
 * make every assertion below pass for the wrong reason.
 */
/*
 * ⚠️ P7-66 Phase 5 — THE ROLE IS NOW LOAD-BEARING, AND IT DEFAULTS TO ADMIN.
 *
 * It used to be incidental: a team leader of the form's department could edit
 * any form, so `team_leader` simply meant "allowed". Since 20260902140000 an
 * INTERNAL form is an admin instrument end to end, and `admin` is
 * what "allowed" means for the forms almost every case below is about. Left as
 * `team_leader`, every one of them would pass or fail on the admin refusal
 * before it ever reached the lock under test — green for the wrong reason, or
 * red for a reason that is not the subject.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports: a
 * plain `let` above would not yet be initialised when the factory runs. Mutable
 * so the block at the foot of this file can drop to `team_leader` and assert
 * that the refusal DOES fire — the coverage that changing this default would
 * otherwise have quietly removed.
 */
const auth = vi.hoisted(() => ({ role: "admin" as "admin" | "team_leader" }));

vi.mock("@/lib/auth/authorization", () => ({
  requireRole: async () => ({
    userId: "user-1",
    email: "test.lead@example.com",
    fullName: "Test Lead",
    role: auth.role,
    departmentIds: ["dept-1"],
  }),
  assertDepartmentAccess: () => {},
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { updateFormSettings } from "@/app/(app)/forms/actions";

/** A complete, valid settings payload. `formSettingsSchema` has no defaults. */
const INTERNAL_SETTINGS = {
  purpose: "INTERNAL" as const,
  name: "Q3 Pulse Survey",
  slug: "q3-pulse-survey",
  description: "",
  department_id: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  reference_prefix: "PUL",
  is_anonymous: false,
  is_active: true,
  requires_attachment: false,
  sla_minutes: DEFAULT_SLA_MINUTES,
  default_list_id: null,
  client_approval_days: 3,
};

function stored(overrides: Partial<FakeConfig["form"]> = {}): FakeConfig["form"] {
  return {
    id: "form-1",
    department_id: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    created_by: "user-1",
    reference_prefix: "PUL",
    purpose: "INTERNAL",
    is_anonymous: false,
    ...overrides,
  };
}

beforeEach(() => {
  // See the mock above: every case here is an admin unless it says otherwise.
  auth.role = "admin";
  fake = makeFakeClient({ form: stored() });
});

describe("⚠️ the purpose lock counts vizserve_pms_form_responses", () => {
  it("REFUSES a purpose change on a form with responses and ZERO requests", async () => {
    // The exact shape of every internal form there will ever be: no requests,
    // because it cannot produce one, and answers in the other table.
    fake = makeFakeClient({
      form: stored(),
      requests: { count: 0 },
      responses: { count: 137 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
    });

    expect(result.ok).toBe(false);
    // And NOTHING was written. A refusal that still ran the update would be a
    // published survey with an apologetic message on the screen.
    expect(fake.recorder.updates).toHaveLength(0);

    if (!result.ok) {
      expect(result.fieldErrors?.purpose?.[0]).toContain("137");
      expect(result.error).toContain("cannot change");
    }
  });

  it("asks BOTH tables, not just requests", async () => {
    // The regression is not "the wrong answer", it is "the question was never
    // asked". Asserted directly so a future refactor that drops the second
    // count fails here rather than in production.
    fake = makeFakeClient({ form: stored(), responses: { count: 1 } });

    await updateFormSettings("form-1", { ...INTERNAL_SETTINGS, purpose: "CLIENT_REQUEST" });

    expect(fake.recorder.counted).toContain("vizserve_pms_requests");
    expect(fake.recorder.counted).toContain("vizserve_pms_form_responses");
  });

  it("refuses on a single response — the threshold is one, not a quorum", async () => {
    fake = makeFakeClient({ form: stored(), responses: { count: 1 } });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
    });

    expect(result.ok).toBe(false);
    // Singular. The message is read by whoever is being refused.
    if (!result.ok) expect(result.fieldErrors?.purpose?.[0]).toContain("1 submission ");
  });

  it("still refuses a client form's purpose change on requests alone", async () => {
    // The pre-existing half of the lock, unchanged by 4b.
    fake = makeFakeClient({
      form: stored({ purpose: "CLIENT_REQUEST", reference_prefix: "COL" }),
      requests: { count: 10 },
      responses: { count: 0 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "INTERNAL",
      reference_prefix: "COL",
    });

    expect(result.ok).toBe(false);
    expect(fake.recorder.updates).toHaveLength(0);
  });

  it("allows a purpose change on a form nobody has answered yet", async () => {
    // The lock must not become "purpose is immutable". A form built this
    // morning and mislabelled is exactly the case it has to let through.
    fake = makeFakeClient({ form: stored(), requests: { count: 0 }, responses: { count: 0 } });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
    });

    expect(result.ok).toBe(true);
    expect(fake.recorder.updates).toHaveLength(1);
    // `is_public` is DERIVED on the way out and never sent by the client.
    expect(fake.recorder.updates[0]).toMatchObject({
      purpose: "CLIENT_REQUEST",
      is_public: true,
    });
  });

  it("leaves an ordinary save alone — the count is only read when it matters", async () => {
    // Renaming a form with a thousand responses must still work. Reading the
    // count on every save would make a failing count block all editing.
    fake = makeFakeClient({ form: stored(), responses: { count: 1000 } });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      name: "Q4 Pulse Survey",
    });

    expect(result.ok).toBe(true);
    expect(fake.recorder.counted).toEqual([]);
    expect(fake.recorder.updates[0]).toMatchObject({
      name: "Q4 Pulse Survey",
      purpose: "INTERNAL",
      is_public: false,
    });
  });
});

/**
 * ⚠️ A COUNT THAT FAILS IS NOT A COUNT OF ZERO.
 *
 * The count used to be `count ?? 0`, so every failure of those two queries — a
 * dropped connection, `permission denied`, or the responses table simply not
 * existing yet because the migration is applied by hand — read as "this form
 * has no submissions" and UNLOCKED the field. That is the same hole again,
 * reached by a network blip instead of by a missing table.
 */
describe("⚠️ the lock fails closed when it cannot count", () => {
  it("refuses the change when the responses count errors", async () => {
    fake = makeFakeClient({
      form: stored(),
      requests: { count: 0 },
      responses: { error: { message: 'relation "vizserve_pms_form_responses" does not exist' } },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
    });

    expect(result.ok).toBe(false);
    expect(fake.recorder.updates).toHaveLength(0);
    // The Postgres sentence is carried through — it names the missing relation,
    // which is the one thing that tells whoever reads it what to do next.
    if (!result.ok) expect(result.error).toContain("vizserve_pms_form_responses");
  });

  it("refuses the change when the requests count errors", async () => {
    fake = makeFakeClient({
      form: stored({ purpose: "CLIENT_REQUEST", reference_prefix: "COL" }),
      requests: { error: { message: "connection reset" } },
      responses: { count: 0 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
      reference_prefix: "NEW",
    });

    expect(result.ok).toBe(false);
    expect(fake.recorder.updates).toHaveLength(0);
  });
});

/**
 * The reference-prefix lock reads the SAME count, and 4b did not change that.
 *
 * It is exact rather than merely conservative: a request can only be created
 * through the public form, which requires `is_public` — i.e. CLIENT_REQUEST —
 * and a response can only be inserted for a form the RLS policy has checked is
 * INTERNAL. One of the two counts is therefore always zero, so the
 * sum names the number both messages claim it does.
 */
describe("the reference-prefix lock still works off the same count", () => {
  it("refuses a prefix change once requests quote it", async () => {
    fake = makeFakeClient({
      form: stored({ purpose: "CLIENT_REQUEST", reference_prefix: "COL" }),
      requests: { count: 4 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
      reference_prefix: "NEW",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.reference_prefix?.[0]).toContain("COL");
  });
});

/**
 * ⚠️⚠️ THE COUNT IS TAKEN AS THE SERVICE ROLE, NOT AS THE CALLER.
 *
 * The second way this lock could be walked past, and it needed no network blip
 * at all — just an UNROUTED form, which `assertCanEditForm` explicitly lets its
 * author edit:
 *
 *   both count policies are `manages_department(form.department_id)`;
 *   `vizserve_pms_manages_department(null)` is FALSE for a team leader;
 *   a failing POLICY returns ZERO ROWS AND NO ERROR (CLAUDE.md).
 *
 * So the fail-closed branch never fired, `submissions` was 0, the lock never
 * engaged, `purpose` flipped to CLIENT_REQUEST, the applied CHECK set
 * `is_public` true — and the staff survey was served at /request/<slug> with no
 * session. Authority is already established by `assertCanEditForm`; how many
 * answers exist is a DATA question, so it is asked of a client that policies
 * cannot filter.
 */
describe("⚠️ the count reads through the service role, never the caller", () => {
  it("still refuses on an UNROUTED form, where the caller's own policy sees nothing", async () => {
    // The exact reachable case: department_id null, edited by its author.
    fake = makeFakeClient({
      form: stored({ department_id: null, created_by: "user-1" }),
      requests: { count: 0 },
      responses: { count: 137 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      department_id: null,
      purpose: "CLIENT_REQUEST",
    });

    expect(result.ok).toBe(false);
    expect(fake.recorder.updates).toHaveLength(0);
    if (!result.ok) expect(result.fieldErrors?.purpose?.[0]).toContain("137");
  });

  it("takes NO count through the caller's RLS client", async () => {
    fake = makeFakeClient({ form: stored(), responses: { count: 3 } });

    await updateFormSettings("form-1", { ...INTERNAL_SETTINGS, purpose: "CLIENT_REQUEST" });

    // The assertion that pins the fix. A regression here reads as a passing
    // lock on a routed form and a silently open one on an unrouted form.
    expect(fake.recorder.countedViaCaller).toEqual([]);
    expect(fake.recorder.counted).toEqual([
      "vizserve_pms_requests",
      "vizserve_pms_form_responses",
    ]);
  });
});

// ---------------------------------------------------------------------------
// P7-66 Phase 5 — THE ADMIN GATE, which is the refusal every case above had to
// be raised past.
// ---------------------------------------------------------------------------

describe("⚠️ an internal form is an admin instrument", () => {
  it("refuses a team leader editing an INTERNAL form", async () => {
    auth.role = "team_leader";

    const result = await updateFormSettings("form-1", INTERNAL_SETTINGS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an admin/i);
  });

  it("⚠️ refuses BEFORE the count, so an unreachable database is not a way past it", async () => {
    /*
     * The same ordering rule the anonymity refusal follows.
     * `countFormSubmissions` decides the purpose and prefix locks and it can
     * fail — if the admin gate sat after it, a dropped count would answer
     * "could not check whether this form has submissions" and a team leader
     * would retry all afternoon, never once being told the real reason.
     *
     * The assertion is that NO count was taken at all: the refusal came first.
     */
    auth.role = "team_leader";

    const result = await updateFormSettings("form-1", INTERNAL_SETTINGS);

    expect(result.ok).toBe(false);
    expect(fake.recorder.counted).toEqual([]);
    expect(fake.recorder.updates).toEqual([]);
  });

  it("⚠️ refuses a team leader CONVERTING a client form into an internal one", async () => {
    /*
     * THE LOOPHOLE THIS CLOSES, and the reason the gate is asked twice — once
     * about the STORED purpose and once about the INCOMING one.
     *
     * The purpose lock only bites once a form has submissions. A fresh client
     * draft has none, so with only the stored-purpose check a team leader could
     * take a form they legitimately manage and turn it into an internal one —
     * reaching the admin-only product through the door left open behind it.
     * `forms updatable in scope` tests both rows for exactly this reason.
     */
    auth.role = "team_leader";
    fake = makeFakeClient({
      form: stored({ purpose: "CLIENT_REQUEST" }),
      requests: { count: 0 },
      responses: { count: 0 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "INTERNAL",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an admin/i);
    expect(fake.recorder.updates).toEqual([]);
  });

  it("leaves a team leader's CLIENT form alone — nothing about it changed", async () => {
    /*
     * The gate must not become a role bump for the product that was always
     * theirs. This is the case that catches a purpose comparison written the
     * wrong way round, which would otherwise lock every team leader out of
     * every form in the app and look, from the code, entirely reasonable.
     */
    auth.role = "team_leader";
    fake = makeFakeClient({
      form: stored({ purpose: "CLIENT_REQUEST" }),
      requests: { count: 0 },
      responses: { count: 0 },
    });

    const result = await updateFormSettings("form-1", {
      ...INTERNAL_SETTINGS,
      purpose: "CLIENT_REQUEST",
      is_anonymous: false,
    });

    expect(result.ok).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { schemaFromFields } from "@/lib/form-builder/schema";
import {
  DEFAULT_SLA_MINUTES,
  formCreateSchema,
  formSettingsSchema,
} from "@/lib/schemas/forms";

/**
 * P7-66 — AN INTERNAL FORM CAN BE ANONYMOUS, AND THE APP HAS TO MEAN IT.
 *
 * 20260902105000_p7_66_form_anonymity.sql put the feature in the database — a
 * column, a CHECK, a trigger — and until this ticket the app could not set it,
 * so the flag was permanently false and every one of those rules was untested
 * dead weight. This file pins the four places the application half can get it
 * wrong, and each of the four is a different kind of broken promise:
 *
 *   1. THE SCHEMA. `is_anonymous` must be undefaulted on the UPDATE schema, like
 *      every other key on it. An omitted `false` on a form running as anonymous
 *      silently starts naming people.
 *   2. THE SETTINGS ACTION. The flag settles before the first answer and never
 *      afterwards, and it is illegal on a client form. Both rules are enforced
 *      by Postgres; this is the readable sentence in front of them.
 *   3. THE WRITE. `submitted_by` comes from the FORM the action re-read, never
 *      from the payload — and on an anonymous form it is NULL, so no name is
 *      written at all.
 *   4. THE READ. The Responses table branches on the FORM's flag, never on
 *      whether one row's `submitted_by` happens to be null.
 *
 * ⚠️ NONE OF THESE IS THE ENFORCEMENT. `form responses insertable by their
 * author` decides what may be written, `vizserve_pms_forms_anonymity_lock`
 * decides when the flag may move, and `vizserve_pms_forms_anonymous_is_internal`
 * decides which forms may carry it. Those are live in production and are not
 * reachable from a unit test (tests/db drives LIVE production and this phase
 * does not run it). What is tested here is that the application says the same
 * things Postgres says, and says them in sentences a person can act on.
 */

// ---------------------------------------------------------------------------
// The fakes. Two Supabase clients, for the reason form-purpose-lock.test.ts
// sets out: "which client counted" has to be observable, because a count taken
// through the caller's own RLS returns zero AND NO ERROR on an unrouted form.
// ---------------------------------------------------------------------------

type CountAnswer = { count?: number; error?: { message: string } };

/** Every column either action reads, on one row, so one fake serves both. */
type FakeForm = {
  id: string;
  name: string;
  slug: string;
  description: string;
  department_id: string | null;
  created_by: string | null;
  reference_prefix: string;
  purpose: "CLIENT_REQUEST" | "EMPLOYEE_ENGAGEMENT";
  is_anonymous: boolean;
  schema: unknown;
};

type FakeConfig = {
  form: FakeForm | null;
  requests?: CountAnswer;
  responses?: CountAnswer;
  insertError?: { message: string; code?: string };
};

type Recorder = {
  /** Tables counted through the SERVICE-ROLE client, in call order. */
  counted: string[];
  /** ⚠️ MUST STAY EMPTY — a count through the caller's RLS is the under-count. */
  countedViaCaller: string[];
  /** Payloads handed to `.update()`. Empty means nothing was written. */
  updates: Record<string, unknown>[];
  /** Payloads handed to `.insert()`, with the table they were sent to. */
  inserts: { table: string; values: Record<string, unknown> }[];
};

const SCHEMA = schemaFromFields([
  {
    id: "b1000000-0000-4000-8000-000000000001",
    label: "How is it going?",
    field_key: "note",
    field_type: "text",
    help_text: "",
    options: [],
    is_required: true,
    is_active: true,
    sort_order: 0,
    created_at: "2026-09-02T10:00:00Z",
  },
]);

function makeFakeClient(config: FakeConfig) {
  const recorder: Recorder = { counted: [], countedViaCaller: [], updates: [], inserts: [] };

  const answerFor = (table: string): CountAnswer => {
    if (table === "vizserve_pms_requests") return config.requests ?? { count: 0 };
    if (table === "vizserve_pms_form_responses") return config.responses ?? { count: 0 };
    throw new Error(`the fake client was asked to count ${table}`);
  };

  function makeClient(via: "service_role" | "caller") {
    return {
      from(table: string) {
        let resolved: Promise<unknown> = Promise.resolve({ error: null });

        const chain = {
          select(columns: string, options?: { count?: string; head?: boolean }) {
            void columns;
            if (!options?.head) return chain;

            if (via === "caller") {
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
          insert(values: Record<string, unknown>) {
            recorder.inserts.push({ table, values });
            resolved = Promise.resolve({ error: config.insertError ?? null });
            return chain;
          },
          update(values: Record<string, unknown>) {
            recorder.updates.push(values);
            resolved = Promise.resolve({ error: null });
            return chain;
          },
          eq() {
            return chain;
          },
          maybeSingle() {
            return Promise.resolve({ data: config.form, error: null });
          },
          // `createForm` ends `insert(...).select("id").single()`. The id is a
          // stand-in: nothing here asserts on it, and the tests that care assert
          // on `recorder.inserts` instead.
          single() {
            return Promise.resolve({
              data: { id: "form-new" },
              error: config.insertError ?? null,
            });
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

function form(overrides: Partial<FakeForm> = {}): FakeForm {
  return {
    id: "form-1",
    name: "Q3 Pulse Survey",
    slug: "q3-pulse-survey",
    description: "",
    department_id: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    created_by: "user-1",
    reference_prefix: "PUL",
    purpose: "EMPLOYEE_ENGAGEMENT",
    is_anonymous: false,
    schema: SCHEMA,
    ...overrides,
  };
}

let fake = makeFakeClient({ form: form() });

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => fake.client,
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => fake.admin,
}));

/**
 * Authorization stubbed to ALLOW, in both of its shapes.
 *
 * `updateFormSettings` asks `requireRole("team_leader")`; `submitFormResponse`
 * asks `requireAuthContext()`. Both are permitted here on purpose — the thing
 * under test is what happens to somebody who IS allowed to be here, and a stub
 * that refused would make every assertion below pass for the wrong reason.
 */
vi.mock("@/lib/auth/authorization", () => {
  const context = {
    userId: "user-1",
    email: "test.lead@example.com",
    fullName: "Test Lead",
    role: "team_leader" as const,
    departmentIds: ["3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"],
  };

  return {
    requireRole: async () => context,
    requireAuthContext: async () => context,
    assertDepartmentAccess: () => {},
    ForbiddenError: class ForbiddenError extends Error {},
  };
});

import { createForm, updateFormSettings } from "@/app/(app)/forms/actions";
import { submitFormResponse } from "@/app/(app)/respond/actions";

/** A complete, valid settings payload. `formSettingsSchema` has no defaults. */
const ENGAGEMENT_SETTINGS = {
  purpose: "EMPLOYEE_ENGAGEMENT" as const,
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

beforeEach(() => {
  fake = makeFakeClient({ form: form() });
});

// ---------------------------------------------------------------------------
// 1. THE SCHEMA
// ---------------------------------------------------------------------------

describe("is_anonymous obeys the no-defaults rule on the UPDATE schema", () => {
  it("refuses an UPDATE that omits it", () => {
    // The omitted value is a broken promise in whichever direction it falls:
    // `false` on an anonymous form starts naming people, `true` on a named one
    // claims anonymity over rows that already carry names.
    const { is_anonymous: _omitted, ...without } = ENGAGEMENT_SETTINGS;
    void _omitted;

    expect(formSettingsSchema.safeParse(without).success).toBe(false);
  });

  it("carries both values through an UPDATE unchanged", () => {
    for (const value of [true, false]) {
      const parsed = formSettingsSchema.parse({ ...ENGAGEMENT_SETTINGS, is_anonymous: value });
      expect(parsed.is_anonymous).toBe(value);
    }
  });

  it("lets a CREATE omit it, and fills in the ATTRIBUTED value", () => {
    // The safe default, and the column's own. An unintended anonymous form loses
    // information nobody can recover; an unintended named one is a mistake that
    // can still be seen and corrected before anybody answers.
    const { is_anonymous: _omitted, ...without } = ENGAGEMENT_SETTINGS;
    void _omitted;

    const parsed = formCreateSchema.parse(without);
    expect(parsed.is_anonymous).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. THE SETTINGS ACTION
// ---------------------------------------------------------------------------

describe("updateFormSettings — anonymity is illegal on a client form", () => {
  it("refuses the pair, and writes nothing", async () => {
    /*
     * Reachable without anybody trying. The switch is hidden on a client form
     * and react-hook-form KEEPS a hidden field's value, so marking a draft
     * anonymous and then changing its purpose posts exactly this pair.
     * `vizserve_pms_forms_anonymous_is_internal` refuses it; this is the
     * sentence in front of that refusal.
     */
    fake = makeFakeClient({ form: form({ purpose: "CLIENT_REQUEST", is_anonymous: false }) });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      purpose: "CLIENT_REQUEST" as const,
      is_anonymous: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/client form cannot be anonymous/i);
      expect(result.fieldErrors?.is_anonymous?.[0]).toBeTruthy();
    }
    expect(fake.recorder.updates).toEqual([]);
  });

  it("checks it BEFORE the count, so a failing count cannot let it through", async () => {
    // The rule is true or false on its own and needs no number. Ordering it
    // after the count would make an unreachable database a way past it.
    fake = makeFakeClient({
      form: form({ purpose: "CLIENT_REQUEST" }),
      requests: { error: { message: "connection reset" } },
    });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      purpose: "CLIENT_REQUEST" as const,
      is_anonymous: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/client form cannot be anonymous/i);
    expect(fake.recorder.counted).toEqual([]);
  });
});

describe("updateFormSettings — the anonymity lock", () => {
  it("refuses named → anonymous once answers exist", async () => {
    /*
     * ⚠️ THE DANGEROUS DIRECTION, and the one that reads as a feature. Thirty
     * answers already carry a name; flipping the flag hides the column and
     * changes nothing in the table. The form would then say "anonymous" over
     * data that is not — still exported, still readable by anyone with SQL.
     */
    fake = makeFakeClient({
      form: form({ is_anonymous: false }),
      requests: { count: 0 },
      responses: { count: 30 },
    });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      is_anonymous: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/cannot change once it has answers/i);
      expect(result.fieldErrors?.is_anonymous?.[0]).toContain("30");
      expect(result.fieldErrors?.is_anonymous?.[0]).toMatch(/named/);
    }
    expect(fake.recorder.updates).toEqual([]);
  });

  it("refuses anonymous → named too", async () => {
    // The gentler half and still wrong: it changes the promise for the
    // thirty-first person, on a form the first thirty are still looking at.
    fake = makeFakeClient({
      form: form({ is_anonymous: true }),
      requests: { count: 0 },
      responses: { count: 30 },
    });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      is_anonymous: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.is_anonymous?.[0]).toMatch(/anonymous/);
    expect(fake.recorder.updates).toEqual([]);
  });

  it("counts the RESPONSES table, not just requests", async () => {
    // An engagement form never produces a request, so a lock that counted only
    // those would never engage on the one kind of form this setting exists for.
    fake = makeFakeClient({
      form: form({ is_anonymous: false }),
      requests: { count: 0 },
      responses: { count: 1 },
    });

    await updateFormSettings("form-1", { ...ENGAGEMENT_SETTINGS, is_anonymous: true });

    expect(fake.recorder.counted).toContain("vizserve_pms_form_responses");
    expect(fake.recorder.countedViaCaller).toEqual([]);
  });

  it("allows the change on a form nobody has answered yet", async () => {
    fake = makeFakeClient({
      form: form({ is_anonymous: false }),
      requests: { count: 0 },
      responses: { count: 0 },
    });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      is_anonymous: true,
    });

    expect(result.ok).toBe(true);
    expect(fake.recorder.updates[0]).toMatchObject({ is_anonymous: true });
  });

  it("fails closed when it cannot count", async () => {
    // Carrying on with zero is the whole hole this lock closes, reopened by a
    // network blip.
    fake = makeFakeClient({
      form: form({ is_anonymous: false }),
      responses: { error: { message: "connection reset" } },
    });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      is_anonymous: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nothing was saved/i);
    expect(fake.recorder.updates).toEqual([]);
  });

  it("takes NO count when the flag is merely resent unchanged", async () => {
    /*
     * A settings save that renamed the form must not pay for two counts, and
     * must not be REFUSED by one. Every other field on the card reaches the
     * update without touching the locks.
     */
    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    const result = await updateFormSettings("form-1", {
      ...ENGAGEMENT_SETTINGS,
      is_anonymous: true,
      name: "Q4 Pulse Survey",
    });

    expect(result.ok).toBe(true);
    expect(fake.recorder.counted).toEqual([]);
    expect(fake.recorder.updates[0]).toMatchObject({
      name: "Q4 Pulse Survey",
      is_anonymous: true,
    });
  });
});

describe("createForm refuses the same illegal pair", () => {
  it("returns a field error rather than a raw CHECK-constraint message", async () => {
    /*
     * The rule was on `updateFormSettings` and not on `createForm`, so the same
     * payload produced a readable field error on one screen and a bare `23514
     * violates check constraint "vizserve_pms_forms_anonymous_is_internal"` —
     * which falls straight past `isUniqueViolation`, anchored to no field — on
     * the other. One helper now, used by both.
     */
    fake = makeFakeClient({ form: form() });

    const result = await createForm({
      purpose: "CLIENT_REQUEST",
      name: "Collateral Request",
      slug: "",
      reference_prefix: "",
      department_id: null,
      is_anonymous: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/client form cannot be anonymous/i);
      expect(result.fieldErrors?.is_anonymous?.[0]).toBeTruthy();
    }
    expect(fake.recorder.inserts).toEqual([]);
  });

  it("creates an anonymous ENGAGEMENT form without complaint", async () => {
    fake = makeFakeClient({ form: form() });

    const result = await createForm({
      purpose: "EMPLOYEE_ENGAGEMENT",
      name: "Q3 Pulse Survey",
      slug: "",
      reference_prefix: "",
      department_id: null,
      is_anonymous: true,
    });

    expect(result.ok).toBe(true);
    expect(fake.recorder.inserts[0].values).toMatchObject({ is_anonymous: true });
  });
});

// ---------------------------------------------------------------------------
// 3. THE WRITE
// ---------------------------------------------------------------------------

describe("submitFormResponse — whose name is written", () => {
  /** The named case. `promised_anonymous` echoes what the page displayed. */
  const payload = {
    slug: "q3-pulse-survey",
    field_values: { note: "Going well." },
    promised_anonymous: false,
  };

  /** The same answer, sent from a page that promised anonymity. */
  const anonPayload = { ...payload, promised_anonymous: true };

  it("writes NO name on an anonymous form", async () => {
    /*
     * ⚠️ NULL, NOT HIDDEN. A name that exists in the row is a name that leaks —
     * through a screen nobody has thought of yet, through `select *`, through
     * an export, through an admin with SQL access. The promise /respond makes
     * to the person's face is that nothing is recorded, so nothing is.
     */
    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    const result = await submitFormResponse(anonPayload);

    expect(result.ok).toBe(true);
    expect(fake.recorder.inserts[0].table).toBe("vizserve_pms_form_responses");
    expect(fake.recorder.inserts[0].values.submitted_by).toBeNull();
  });

  it("writes the session's user on a named form", async () => {
    fake = makeFakeClient({ form: form({ is_anonymous: false }) });

    const result = await submitFormResponse(payload);

    expect(result.ok).toBe(true);
    expect(fake.recorder.inserts[0].values.submitted_by).toBe("user-1");
  });

  it("reads the flag from the FORM, never from the payload", async () => {
    /*
     * ⚠️ THE ATTACK THIS CLOSES RUNS BOTH WAYS. A caller who could send
     * `is_anonymous` could strip their own name off a named survey — or, far
     * worse, attach a name to an anonymous one, which is the case the person
     * answering was promised could not happen. `formResponseSubmissionSchema`
     * carries only `slug` and `field_values`, and the flag comes off the row the
     * action just re-read.
     */
    fake = makeFakeClient({ form: form({ is_anonymous: false }) });

    const result = await submitFormResponse({ ...payload, is_anonymous: true });

    expect(result.ok).toBe(true);
    expect(fake.recorder.inserts[0].values.submitted_by).toBe("user-1");

    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    const reversed = await submitFormResponse({ ...anonPayload, is_anonymous: false });

    expect(reversed.ok).toBe(true);
    expect(fake.recorder.inserts[0].values.submitted_by).toBeNull();
  });

  it("sends neither `id` nor `submitted_at`", async () => {
    /*
     * ⚠️ THE COLUMN-LEVEL GRANT IS EXHAUSTIVE:
     *
     *   grant insert (form_id, submitted_by, field_values) ...
     *
     * Naming `id` or `submitted_at` in the insert — even with the value the
     * column would have defaulted to — is a privilege check against a privilege
     * that was never granted, and Postgres refuses the whole statement (42501)
     * rather than ignoring the key. Both have defaults precisely so nobody has
     * to send them.
     */
    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    await submitFormResponse(anonPayload);

    expect(Object.keys(fake.recorder.inserts[0].values).sort()).toEqual([
      "field_values",
      "form_id",
      "submitted_by",
    ]);
  });
});

describe("submitFormResponse — the promise the screen made must still hold", () => {
  const values = { note: "Going well." };

  it("refuses an answer typed under a promise the form has since dropped", async () => {
    /*
     * ⚠️ THE RACE, AND IT IS THE ONE THE FEATURE EXISTS TO PREVENT. The lock
     * settles the flag on the FIRST answer — so until then it can legitimately
     * move, and /respond states which kind of form it is at RENDER time.
     * Somebody reads "your name is not recorded", the owner flips the switch on
     * a form nobody has answered yet, and the name is written under a page that
     * promised none.
     */
    fake = makeFakeClient({ form: form({ is_anonymous: false }) });

    const result = await submitFormResponse({
      slug: "q3-pulse-survey",
      field_values: values,
      promised_anonymous: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer\s+anonymous|Nothing was saved/i);
    expect(fake.recorder.inserts).toEqual([]);
  });

  it("refuses the other direction too, rather than quietly dropping the name", async () => {
    // Less damaging and still not ours to decide on somebody's behalf: they
    // answered expecting to be named, and the record would say otherwise.
    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    const result = await submitFormResponse({
      slug: "q3-pulse-survey",
      field_values: values,
      promised_anonymous: false,
    });

    expect(result.ok).toBe(false);
    expect(fake.recorder.inserts).toEqual([]);
  });

  it("refuses a payload that states no promise at all", async () => {
    // Required, not optional. An omitted key is a client that has not been told
    // about the setting — which is precisely the client that cannot be trusted
    // to have displayed the right sentence.
    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    const result = await submitFormResponse({ slug: "q3-pulse-survey", field_values: values });

    expect(result.ok).toBe(false);
    expect(fake.recorder.inserts).toEqual([]);
  });

  it("still never lets the payload DECIDE — a match writes what the form says", async () => {
    /*
     * The guarantee that makes a caller-supplied value safe here: agreement
     * causes the write to proceed under the FORM's flag, and disagreement
     * causes a refusal. There is no path where this field chooses.
     */
    fake = makeFakeClient({ form: form({ is_anonymous: true }) });

    const result = await submitFormResponse({
      slug: "q3-pulse-survey",
      field_values: values,
      promised_anonymous: true,
    });

    expect(result.ok).toBe(true);
    expect(fake.recorder.inserts[0].values.submitted_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. THE READ
//
// ⚠️ NOTHING TO TEST HERE ANY MORE, AND THAT IS THE POINT — P7-66 Phase 4.
//
// This section pinned `responseViewsFor`: that an anonymous form offered
// Summary and Question but no INDIVIDUAL view, because `submitted_by` is null
// on every row and the view could only have paged through submissions labelled
// "somebody" while presenting them as separable people.
//
// There are no views left to choose between. The Responses tab is a count and,
// on a named form, who answered — so anonymity does not remove a view, it
// removes the list of people, which is a branch in the component rather than a
// pure function worth its own suite.
//
// ⚠️ THE RULE THE FUNCTION EXISTED TO ENFORCE IS STILL LIVE, AND IT IS THE ONE
// WORTH REPEATING: anonymity is read off `vizserve_pms_forms.is_anonymous` and
// never off `rows.every((r) => r.submitted_by === null)`. An empty page
// satisfies that shortcut, and so does a page whose only author sits outside the
// reader's department — either would declare a NAMED form anonymous and drop the
// attribution off answers that carry it. `FormResponses` takes the flag as a
// prop and reads no rows to decide; sections 1–3 above are what stop the flag
// itself being wrong.
// ---------------------------------------------------------------------------

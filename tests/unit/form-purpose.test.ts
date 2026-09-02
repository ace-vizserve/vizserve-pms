import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLA_MINUTES,
  FORM_PURPOSES,
  FORM_PURPOSE_LABELS,
  formCreateSchema,
  formSettingsSchema,
  isPublicForPurpose,
  prefixFromName,
  slugFromName,
  type FormPurpose,
} from "@/lib/schemas/forms";

/**
 * P7-66 — WHAT A FORM IS FOR.
 *
 * The load-bearing test is the first block. `isPublicForPurpose` is the
 * TypeScript twin of a CHECK constraint that is live in production:
 *
 *   check (is_public = (purpose = 'CLIENT_REQUEST'))
 *
 * Two copies of one rule, in two languages, and only one of them is enforced.
 * If they drift, the cheap outcome is every save being rejected by Postgres; the
 * expensive one is an engagement form written with `is_public = true`, which
 * `vizserve_pms_get_public_form` — whose where clause is `slug and is_public and
 * is_active`, and which has never heard of `purpose` — would then serve to
 * anybody with the URL, no session.
 *
 * These are unit tests: they pin the TypeScript half. The database half is the
 * constraint itself, and it is not reachable from here (tests/db drives LIVE
 * production and is not run by this phase).
 */

/**
 * The settings a client-request form has to carry, so each test below can state
 * only the thing it is about. Reused from the shape `form-identifiers.test.ts`
 * parses through — same schema, same required set.
 */
const CLIENT_SETTINGS = {
  purpose: "CLIENT_REQUEST" as const,
  name: "Collateral Request",
  slug: "collateral-request",
  description: "",
  department_id: null,
  reference_prefix: "COL",
  is_active: true,
  requires_attachment: false,
  sla_minutes: DEFAULT_SLA_MINUTES,
  default_list_id: null,
  client_approval_days: 3,
};

/**
 * A PUBLISHED STAFF FORM — the row the security bug below was reaching for.
 *
 * `is_active: true` matters: an unpublished form is not served by
 * `vizserve_pms_get_public_form` whatever `is_public` says, so the damaging
 * case is specifically a LIVE engagement form being flipped public.
 */
const ENGAGEMENT_SETTINGS = {
  ...CLIENT_SETTINGS,
  purpose: "EMPLOYEE_ENGAGEMENT" as const,
  name: "Q3 Pulse Survey",
  slug: "q3-pulse-survey",
  reference_prefix: "PUL",
  is_active: true,
};

/**
 * Every key `formSettingsSchema` used to default, with a value that is NOT the
 * default — so "the payload omitted it" and "the payload meant this" cannot be
 * confused. `purpose` leads because it is the one that was a security hole.
 */
const FORMERLY_DEFAULTED = {
  purpose: "EMPLOYEE_ENGAGEMENT",
  description: "Runs every quarter.",
  is_active: true,
  requires_attachment: true,
  default_list_id: "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  client_approval_days: 7,
} as const;

describe("isPublicForPurpose — the CHECK constraint, in TypeScript", () => {
  it("is true for a client request and false for an engagement form", () => {
    expect(isPublicForPurpose("CLIENT_REQUEST")).toBe(true);
    expect(isPublicForPurpose("EMPLOYEE_ENGAGEMENT")).toBe(false);
  });

  it("satisfies `is_public = (purpose = 'CLIENT_REQUEST')` for every purpose", () => {
    // Written as the constraint is written, over the whole enum rather than the
    // two cases above — a third purpose added without a rule here fails loudly
    // instead of silently defaulting to "not public".
    for (const purpose of FORM_PURPOSES) {
      expect(isPublicForPurpose(purpose)).toBe(purpose === "CLIENT_REQUEST");
    }
  });

  it("covers every enum member with a label, a short label and a hint", () => {
    for (const purpose of FORM_PURPOSES) {
      const entry = FORM_PURPOSE_LABELS[purpose];
      expect(entry.label.trim()).not.toBe("");
      expect(entry.short.trim()).not.toBe("");
      expect(entry.hint.trim()).not.toBe("");
      // Never the raw enum on a screen — the rule check:select-items exists for.
      expect(entry.label).not.toBe(purpose);
      expect(entry.short).not.toBe(purpose);
    }
  });
});

describe("the schemas refuse to carry is_public at all", () => {
  it("strips it rather than round-tripping a value the server would ignore", () => {
    // A client that sends the contradiction the CHECK would reject must not get
    // it back out of the parse as if it had been accepted.
    const parsed = formSettingsSchema.parse({
      ...CLIENT_SETTINGS,
      purpose: "EMPLOYEE_ENGAGEMENT",
      is_public: true,
    });

    expect(parsed).not.toHaveProperty("is_public");
    expect(isPublicForPurpose(parsed.purpose)).toBe(false);
  });

  it("rejects a purpose that is not one of the two", () => {
    const parsed = formSettingsSchema.safeParse({ ...CLIENT_SETTINGS, purpose: "INTERNAL" });
    expect(parsed.success).toBe(false);
  });
});

describe("formCreateSchema — an engagement form needs a name and nothing else", () => {
  const parseCreate = (input: Record<string, unknown>) => {
    const parsed = formCreateSchema.safeParse(input);
    if (!parsed.success) throw new Error(`refused: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  };

  it("accepts { purpose, name } and fills in everything the flow does not ask for", () => {
    // This IS the Google-Forms flow: /forms/new sends these two fields (plus a
    // department it derived) and the schema has to make a legal insert of it.
    const data = parseCreate({ purpose: "EMPLOYEE_ENGAGEMENT", name: "Q3 Pulse Survey" });

    expect(data.purpose).toBe("EMPLOYEE_ENGAGEMENT");
    // Blank is the signal `createForm` reads as "derive it", not a bad value.
    expect(data.slug).toBe("");
    expect(data.reference_prefix).toBe("");
    // Meaningless on an engagement form, so never asked and never zero.
    expect(data.sla_minutes).toBe(DEFAULT_SLA_MINUTES);
    expect(data.client_approval_days).toBe(3);
    expect(data.default_list_id).toBeNull();
    // An unrouted draft. Visible to its author, unpublishable until routed.
    expect(data.department_id).toBeNull();
    expect(data.is_active).toBe(false);
  });

  it("derives a slug and a prefix that the settings schema will then accept", () => {
    // The property that matters: what `createForm` derives from a blank must
    // PASS `formSettingsSchema`, or the form becomes unsaveable the first time
    // somebody opens its settings card.
    const name = "Q3 Pulse Survey";
    const derived = {
      ...CLIENT_SETTINGS,
      purpose: "EMPLOYEE_ENGAGEMENT" as FormPurpose,
      name,
      slug: slugFromName(name),
      reference_prefix: prefixFromName(name),
    };

    expect(derived.slug).toBe("q3-pulse-survey");
    expect(formSettingsSchema.safeParse(derived).success).toBe(true);
  });

  it("still refuses a blank name — the one thing the flow does ask for", () => {
    expect(formCreateSchema.safeParse({ purpose: "EMPLOYEE_ENGAGEMENT" }).success).toBe(false);
    expect(
      formCreateSchema.safeParse({ purpose: "EMPLOYEE_ENGAGEMENT", name: "   " }).success,
    ).toBe(false);
  });

  it("leaves the client-request path exactly as it was", () => {
    const data = parseCreate({ ...CLIENT_SETTINGS, slug: "", reference_prefix: "" });

    expect(data.purpose).toBe("CLIENT_REQUEST");
    expect(isPublicForPurpose(data.purpose)).toBe(true);
    expect(data.slug).toBe("");
    expect(data.reference_prefix).toBe("");
  });
});

describe("formSettingsSchema — an UPDATE cannot accept the blanks an INSERT can", () => {
  it("still demands a slug, a prefix and an SLA on an engagement form", () => {
    // The settings card HIDES the prefix and the SLA on an engagement form; it
    // does not unregister them, and this is why. A save that dropped the values
    // would be refused here, with the error landing on a field nobody can see.
    for (const blank of [
      { slug: "" },
      { reference_prefix: "" },
      { sla_minutes: "" },
    ]) {
      const parsed = formSettingsSchema.safeParse({
        ...CLIENT_SETTINGS,
        purpose: "EMPLOYEE_ENGAGEMENT",
        ...blank,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts an engagement form carrying the values it was created with", () => {
    const parsed = formSettingsSchema.safeParse({
      ...CLIENT_SETTINGS,
      purpose: "EMPLOYEE_ENGAGEMENT",
      name: "Q3 Pulse Survey",
      slug: "q3-pulse-survey",
      reference_prefix: "PUL",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(isPublicForPurpose(parsed.data.purpose)).toBe(false);
  });
});

/**
 * ⚠️⚠️ THE REGRESSION THAT MATTERS. A code review found a way to publish a
 * staff form by SAYING NOTHING.
 *
 * `purpose` was `.default("CLIENT_REQUEST")` on `formSettingsSchema`. Since
 * every key that parses is handed straight to `.update()`, an
 * `updateFormSettings` payload that merely OMITTED `purpose` rewrote a live
 * EMPLOYEE_ENGAGEMENT form as CLIENT_REQUEST. `isPublicForPurpose` then set
 * `is_public` true — as the applied CHECK `is_public = (purpose =
 * 'CLIENT_REQUEST')` requires — and `vizserve_pms_get_public_form`, whose where
 * clause is `slug and is_public and is_active` and which has never heard of
 * `purpose`, served the form and its questions at /request/<slug> to anybody
 * with the URL. No session.
 *
 * The purpose lock in `updateFormSettings` could not stop it: the lock counts
 * `vizserve_pms_requests`, and an engagement form never produces one — a pulse
 * survey with a thousand answers counts zero.
 *
 * So the fix is at the schema, and this is the test of it: OMITTING A
 * SECURITY-RELEVANT FIELD ON AN UPDATE IS AN ERROR, NEVER A VALUE.
 */
describe("⚠️ formSettingsSchema — an UPDATE may not default `purpose`", () => {
  it("REFUSES a payload that omits purpose rather than reading it as CLIENT_REQUEST", () => {
    const withoutPurpose = Object.fromEntries(
      Object.entries(ENGAGEMENT_SETTINGS).filter(([key]) => key !== "purpose"),
    );

    const parsed = formSettingsSchema.safeParse(withoutPurpose);

    expect(parsed.success).toBe(false);
    // On the right field, so the settings card can say what is missing rather
    // than failing somewhere generic.
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "purpose",
    );
  });

  it("refuses every not-quite-a-purpose a payload could carry", () => {
    // Explicit `undefined` is the shape the bug actually took — a client that
    // sends `{...values}` where `values.purpose` was never populated.
    for (const purpose of [undefined, null, "", "CLIENT", "client_request", 0, false, {}]) {
      const parsed = formSettingsSchema.safeParse({ ...ENGAGEMENT_SETTINGS, purpose });
      expect(parsed.success).toBe(false);
    }
  });

  it("AN ENGAGEMENT FORM STAYS AN ENGAGEMENT FORM, AND STAYS NON-PUBLIC", () => {
    // The property stated directly: there is no accepted settings payload,
    // starting from a stored engagement form, whose parse comes out public.
    // Either the payload says EMPLOYEE_ENGAGEMENT, or it is refused.
    const candidates: Array<Record<string, unknown>> = [
      ENGAGEMENT_SETTINGS,
      { ...ENGAGEMENT_SETTINGS, name: "Q4 Pulse Survey" },
      { ...ENGAGEMENT_SETTINGS, is_active: false },
      { ...ENGAGEMENT_SETTINGS, description: "" },
      // The attack: say nothing about what the form is for.
      Object.fromEntries(
        Object.entries(ENGAGEMENT_SETTINGS).filter(([key]) => key !== "purpose"),
      ),
    ];

    for (const candidate of candidates) {
      const parsed = formSettingsSchema.safeParse(candidate);
      if (!parsed.success) continue;

      expect(parsed.data.purpose).toBe("EMPLOYEE_ENGAGEMENT");
      expect(isPublicForPurpose(parsed.data.purpose)).toBe(false);
    }
  });

  it("still accepts a client form that states its purpose", () => {
    // The fix must not make the ordinary save fail: the settings card sends
    // every one of these, and it has to keep parsing.
    const parsed = formSettingsSchema.safeParse(CLIENT_SETTINGS);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(isPublicForPurpose(parsed.data.purpose)).toBe(true);
  });
});

/**
 * THE WIDER AUDIT, AS A TEST.
 *
 * `purpose` was the security one. The other five defaults on the UPDATE schema
 * each DISCARDED a stored choice when the payload left them out — a blanked
 * description, an unpublished form, a dropped attachment requirement, lost
 * routing, a reset Gate 3 window. Same mechanism, quieter blast radius.
 *
 * The rule this pins: `formSettingsSchema` has NO defaults; `formCreateSchema`
 * has all of them. A default belongs on the schema for the row that does not
 * exist yet, never on the schema for the row that does.
 */
describe("formSettingsSchema carries no defaults at all", () => {
  for (const [key, value] of Object.entries(FORMERLY_DEFAULTED)) {
    it(`refuses an UPDATE that omits ${key}`, () => {
      const stated = { ...CLIENT_SETTINGS, [key]: value };
      // Stating it is fine; the payload just has to state it.
      expect(formSettingsSchema.safeParse(stated).success).toBe(true);

      const omitted = Object.fromEntries(
        Object.entries(stated).filter(([name]) => name !== key),
      );
      expect(formSettingsSchema.safeParse(omitted).success).toBe(false);
    });

    it(`still lets a CREATE omit ${key}`, () => {
      // /forms/new sends a name and a purpose. Everything else is filled in,
      // and that is legitimate: a form that does not exist has nothing to lose.
      const omitted = Object.fromEntries(
        Object.entries({ ...CLIENT_SETTINGS, [key]: value }).filter(([name]) => name !== key),
      );
      expect(formCreateSchema.safeParse(omitted).success).toBe(true);
    });
  }

  it("round-trips a parsed UPDATE without dropping a key", () => {
    // The output feeds `.update()` directly, so a key going missing here is a
    // column being left alone — the opposite failure, and worth pinning too.
    const parsed = formSettingsSchema.parse({ ...CLIENT_SETTINGS, ...FORMERLY_DEFAULTED });

    for (const key of Object.keys(CLIENT_SETTINGS)) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed).not.toHaveProperty("is_public");
  });
});

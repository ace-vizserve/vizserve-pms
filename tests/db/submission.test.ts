import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";
import {
  DEPARTMENTS,
  adminClient,
  anonClient,
  dbTestsEnabled,
  signIn,
  skipReason,
} from "./helpers";

/**
 * P0-12 / Phase 1 exit criteria — the public submission surface.
 *
 * These are the assertions the Phase 1 checklist was waiting on. Every one of
 * them goes through `vizserve_pms_submit_request` as `anon`, i.e. exactly the
 * `curl` the exit criterion describes: no session, no browser, no client-side
 * zod. If the database is not the enforcement layer, these fail.
 *
 * The fixture form is built here rather than reusing the seeded one, so a
 * re-seed cannot change what these assert.
 */

if (!dbTestsEnabled) console.warn(`\n  submission.test.ts — ${skipReason}\n`);

const SLUG = `p012-fixture-${Math.random().toString(36).slice(2, 10)}`;
const PREFIX = `T${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

let formId: string;

describe.skipIf(!dbTestsEnabled)("P1 public submission", () => {
  beforeAll(async () => {
    const admin = adminClient();

    const { data: form, error } = await admin
      .from("vizserve_pms_forms")
      .insert({
        name: "P0-12 fixture form",
        slug: SLUG,
        description: "Created by the test suite. Safe to delete.",
        department_id: DEPARTMENTS.VizBytes,
        // Unique per run: reference_prefix is globally unique (P1-10), so a
        // fixed literal collides with any earlier run that failed before cleanup.
        reference_prefix: PREFIX,
        is_public: true,
        is_active: true,
        sla_days: 3,
      })
      .select("id")
      .single();

    if (error) throw new Error(`fixture form: ${error.message}`);
    formId = form!.id;

    // `options` is spelled out on every row, including the ones that have none.
    // PostgREST requires a uniform column set for a bulk insert, so supabase-js
    // pads missing keys with NULL rather than letting the column default apply —
    // which trips the not-null constraint on the rows that omitted it.
    const { error: fieldError } = await admin.from("vizserve_pms_form_fields").insert([
      {
        form_id: formId,
        label: "Deliverable",
        field_key: "deliverable",
        field_type: "text",
        options: [],
        is_required: true,
        sort_order: 10,
      },
      {
        form_id: formId,
        label: "Channel",
        field_key: "channel",
        field_type: "select",
        options: ["Facebook", "Instagram"],
        is_required: true,
        sort_order: 20,
      },
      {
        form_id: formId,
        label: "Notes",
        field_key: "notes",
        field_type: "textarea",
        options: [],
        is_required: false,
        sort_order: 30,
      },
    ]);

    if (fieldError) throw new Error(`fixture fields: ${fieldError.message}`);
  });

  afterAll(async () => {
    if (!formId) return;
    const admin = adminClient();

    // Requests reference the form with `on delete restrict`, so they go first.
    await admin.from("vizserve_pms_requests").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_public_submission_log").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_reference_counters").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_forms").delete().eq("id", formId);
  });

  function submit(payload: Record<string, unknown>, ip = `10.0.0.${Math.floor(Math.random() * 250)}`) {
    return anonClient().rpc("vizserve_pms_submit_request", {
      p_slug: SLUG,
      // The whole point of these tests is sending shapes the UI would never
      // build, so the payload is deliberately loose and cast at the boundary.
      p_payload: payload as Json,
      p_attachments: [],
      p_ip: ip,
    });
  }

  function completePayload(overrides: Record<string, unknown> = {}) {
    return {
      requester_name: "Juan dela Cruz",
      requester_email: `p012.${Math.random().toString(36).slice(2, 8)}@example.com`,
      requester_org: "HFSE",
      title: "Fixture request",
      description: "Submitted by the P0-12 suite.",
      target_date: "2026-12-01",
      field_values: { deliverable: "Poster", channel: "Facebook" },
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // "A submission missing a required field is rejected server-side, proven by a
  //  direct API call that bypasses the UI."
  // -------------------------------------------------------------------------
  describe("completeness is enforced by the database", () => {
    it("rejects a payload missing a required per-form field", async () => {
      const { data } = await submit(
        completePayload({ field_values: { channel: "Facebook" } }),
      );

      const result = data as { ok: boolean; error?: string; field_errors?: Record<string, string> };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("validation_failed");
      expect(result.field_errors).toHaveProperty("deliverable");
    });

    it("rejects whitespace as an answer, not just an absent key", async () => {
      // "   " is a thing browsers genuinely submit, and it satisfies a naive
      // `is not null` check while satisfying no human.
      const { data } = await submit(
        completePayload({ field_values: { deliverable: "   ", channel: "Facebook" } }),
      );

      expect((data as { ok: boolean }).ok).toBe(false);
      expect((data as { field_errors: Record<string, string> }).field_errors).toHaveProperty(
        "deliverable",
      );
    });

    it("rejects an empty array for a required field", async () => {
      const { data } = await submit(
        completePayload({ field_values: { deliverable: [], channel: "Facebook" } }),
      );
      expect((data as { ok: boolean }).ok).toBe(false);
    });

    it("rejects a select value that is not one of the offered options", async () => {
      const { data } = await submit(
        completePayload({ field_values: { deliverable: "Poster", channel: "TikTok" } }),
      );

      expect((data as { ok: boolean }).ok).toBe(false);
      expect((data as { field_errors: Record<string, string> }).field_errors).toHaveProperty(
        "channel",
      );
    });

    it("rejects a missing requester email — the Phase 4 identity", async () => {
      const { data } = await submit(completePayload({ requester_email: "" }));

      expect((data as { ok: boolean }).ok).toBe(false);
      expect((data as { field_errors: Record<string, string> }).field_errors).toHaveProperty(
        "requester_email",
      );
    });

    it("reports every failing field at once, not just the first", async () => {
      // A validator that stops at the first error turns one round trip into
      // five for the client.
      const { data } = await submit({
        requester_name: "",
        requester_email: "",
        title: "",
        description: "",
        field_values: {},
      });

      const errors = (data as { field_errors: Record<string, string> }).field_errors;
      expect(Object.keys(errors).length).toBeGreaterThanOrEqual(6);
    });

    it("does not create a request row for a rejected submission", async () => {
      const { data: before } = await adminClient()
        .from("vizserve_pms_requests")
        .select("id")
        .eq("form_id", formId);

      await submit(completePayload({ field_values: {} }));

      const { data: after } = await adminClient()
        .from("vizserve_pms_requests")
        .select("id")
        .eq("form_id", formId);

      expect(after!.length).toBe(before!.length);
    });
  });

  // -------------------------------------------------------------------------
  // The happy path
  // -------------------------------------------------------------------------
  describe("a complete submission", () => {
    it("creates a request, a reference number and starts the SLA timer", async () => {
      const { data } = await submit(completePayload());
      const result = data as { ok: boolean; request_id: string; reference_no: string };

      expect(result.ok).toBe(true);
      // Escaped for the template literal: `\d` inside a backtick string is just
      // "d", which happily matches nothing and quietly passes on the wrong shape.
      expect(result.reference_no).toMatch(new RegExp(`^${PREFIX}-\\d{4}-\\d{4}$`));

      const { data: request } = await adminClient()
        .from("vizserve_pms_requests")
        .select("status, sla_started_at, field_values, target_date")
        .eq("id", result.request_id)
        .single();

      expect(request!.status).toBe("PENDING_REVIEW");
      expect(request!.sla_started_at).not.toBeNull();
      expect(request!.target_date).toBe("2026-12-01");
      expect(request!.field_values).toMatchObject({ deliverable: "Poster", channel: "Facebook" });
    });

    it("issues gapless sequential reference numbers per form per year", async () => {
      // A client quoting TST-2026-0142 to a colleague who sees 0141 then 0143
      // asks why. Hence a counter table rather than a sequence.
      const first = (await submit(completePayload())).data as { reference_no: string };
      const second = (await submit(completePayload())).data as { reference_no: string };

      const seq = (ref: string) => Number(ref.split("-")[2]);
      expect(seq(second.reference_no)).toBe(seq(first.reference_no) + 1);
    });

    it("does not store a value for an optional field left blank", async () => {
      // An untouched input must not land in field_values as "" pretending to be
      // an answer — the task board and the Phase 4 page both render it.
      const { data } = await submit(completePayload({
        field_values: { deliverable: "Poster", channel: "Facebook", notes: "" },
      }));

      const { data: request } = await adminClient()
        .from("vizserve_pms_requests")
        .select("field_values")
        .eq("id", (data as { request_id: string }).request_id)
        .single();

      expect(request!.field_values).not.toHaveProperty("notes");
    });

    it("writes an audit row on submission", async () => {
      const { data } = await submit(completePayload());
      const requestId = (data as { request_id: string }).request_id;

      const { data: audit } = await adminClient()
        .from("vizserve_pms_audit_logs")
        .select("action, entity_type")
        .eq("entity_id", requestId);

      expect(audit).toHaveLength(1);
      expect(audit![0]).toMatchObject({ entity_type: "request", action: "submitted" });
    });

    it("notifies the leaders of the owning department and nobody else", async () => {
      const { data } = await submit(completePayload());
      const requestId = (data as { request_id: string }).request_id;

      const { data: notifications } = await adminClient()
        .from("vizserve_pms_notifications")
        .select("user_id, type, link_path, vizserve_pms_users!inner(email)")
        .eq("entity_id", requestId);

      expect(notifications!.length).toBeGreaterThan(0);

      for (const row of notifications as unknown as {
        type: string;
        link_path: string;
        vizserve_pms_users: { email: string };
      }[]) {
        expect(row.type).toBe("pending_approval");
        // Every notification links to the exact record, never to a dashboard the
        // recipient then has to search (docs/12 §3 rule 2).
        expect(row.link_path).toBe(`/requests/${requestId}`);
        // VizBytes only. A TL of VizAssists must not be told about this.
        expect(row.vizserve_pms_users.email.toLowerCase()).not.toContain("vizassists");
      }
    });
  });

  // -------------------------------------------------------------------------
  // "The request appears in the correct TL's queue and nowhere else."
  // -------------------------------------------------------------------------
  describe("queue routing is enforced by RLS, not by the query", () => {
    let requestId: string;

    beforeAll(async () => {
      const { data } = await submit(completePayload({ title: "Routing fixture" }));
      requestId = (data as { request_id: string }).request_id;
    });

    it("is visible to the TL of the owning department", async () => {
      const { client } = await signIn("tlVizBytes");
      const { data, error } = await client
        .from("vizserve_pms_requests")
        .select("id")
        .eq("id", requestId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("is invisible to a TL of another department — zero rows, not an error", async () => {
      const { client } = await signIn("tlVizAssists");
      const { data, error } = await client
        .from("vizserve_pms_requests")
        .select("id")
        .eq("id", requestId);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("is invisible to a member of the owning department", async () => {
      // Being in VizBytes is not the same as leading VizBytes. Members reach
      // work through tasks (Phase 3), never through the request queue.
      const { client } = await signIn("member1VizBytes");
      const { data } = await client.from("vizserve_pms_requests").select("id").eq("id", requestId);

      expect(data).toEqual([]);
    });

    it("is visible to an admin", async () => {
      const { client } = await signIn("admin");
      const { data } = await client.from("vizserve_pms_requests").select("id").eq("id", requestId);

      expect(data).toHaveLength(1);
    });

    it("cannot be edited by a TL outside the department", async () => {
      const { client } = await signIn("tlVizAssists");

      await client
        .from("vizserve_pms_requests")
        .update({ title: "Hijacked" })
        .eq("id", requestId);

      const { data } = await adminClient()
        .from("vizserve_pms_requests")
        .select("title")
        .eq("id", requestId)
        .single();

      expect(data!.title).toBe("Routing fixture");
    });
  });

  // -------------------------------------------------------------------------
  // "Rate limiting demonstrably blocks a submission flood." (P1-15)
  // -------------------------------------------------------------------------
  describe("abuse controls", () => {
    it("blocks a flood from one IP once the hourly limit is reached", async () => {
      const admin = adminClient();
      const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;

      const { data: limits } = await admin
        .from("vizserve_pms_public_submission_limits")
        .select("per_ip_per_hour")
        .eq("id", true)
        .single();

      const limit = limits!.per_ip_per_hour;
      const outcomes: string[] = [];

      // One more than the limit, each with a distinct email so it is the IP
      // ceiling being tested and not the per-email one.
      for (let i = 0; i <= limit; i++) {
        const { data } = await submit(completePayload(), ip);
        const result = data as { ok: boolean; error?: string };
        outcomes.push(result.ok ? "accepted" : result.error!);
      }

      expect(outcomes.filter((o) => o === "accepted").length).toBeLessThanOrEqual(limit);
      expect(outcomes.at(-1)).toBe("rate_limited");

      await admin.from("vizserve_pms_public_submission_log").delete().eq("ip", ip);
    });

    it("blocks a flood from one email address across different IPs", async () => {
      const admin = adminClient();
      const email = `p012.flood.${Math.random().toString(36).slice(2, 8)}@example.com`;

      const { data: limits } = await admin
        .from("vizserve_pms_public_submission_limits")
        .select("per_email_per_hour")
        .eq("id", true)
        .single();

      const limit = limits!.per_email_per_hour;
      let lastError = "";

      for (let i = 0; i <= limit; i++) {
        const { data } = await submit(
          completePayload({ requester_email: email }),
          `203.0.113.${i}`,
        );
        const result = data as { ok: boolean; error?: string };
        if (!result.ok) lastError = result.error!;
      }

      expect(lastError).toBe("rate_limited");
      await admin.from("vizserve_pms_public_submission_log").delete().eq("email", email);
    });
  });

  // -------------------------------------------------------------------------
  // "A field can be renamed without breaking existing requests, and a field with
  //  data cannot be hard-deleted." (R5 / D20)
  // -------------------------------------------------------------------------
  describe("form evolution guards", () => {
    it("allows a label rename, leaving stored answers intact", async () => {
      const admin = adminClient();
      const { data: submission } = await submit(completePayload());
      const requestId = (submission as { request_id: string }).request_id;

      const { error } = await admin
        .from("vizserve_pms_form_fields")
        .update({ label: "Deliverable (renamed)" })
        .eq("form_id", formId)
        .eq("field_key", "deliverable");

      expect(error).toBeNull();

      const { data: request } = await admin
        .from("vizserve_pms_requests")
        .select("field_values")
        .eq("id", requestId)
        .single();

      expect(request!.field_values).toMatchObject({ deliverable: "Poster" });

      await admin
        .from("vizserve_pms_form_fields")
        .update({ label: "Deliverable" })
        .eq("form_id", formId)
        .eq("field_key", "deliverable");
    });

    it("refuses to change field_key once the form has submissions", async () => {
      // Historical field_values are keyed to it. Changing the key orphans every
      // answer already stored, silently.
      const { error } = await adminClient()
        .from("vizserve_pms_form_fields")
        .update({ field_key: "deliverable_v2" })
        .eq("form_id", formId)
        .eq("field_key", "deliverable");

      expect(error).not.toBeNull();
    });

    it("refuses a hard delete of a field on a form with submissions", async () => {
      const { error } = await adminClient()
        .from("vizserve_pms_form_fields")
        .delete()
        .eq("form_id", formId)
        .eq("field_key", "deliverable");

      expect(error).not.toBeNull();
    });

    it("allows archiving instead, and the archived field stops being required", async () => {
      const admin = adminClient();

      await admin
        .from("vizserve_pms_form_fields")
        .update({ is_active: false })
        .eq("form_id", formId)
        .eq("field_key", "notes");

      const { data } = await submit(completePayload());
      expect((data as { ok: boolean }).ok).toBe(true);

      await admin
        .from("vizserve_pms_form_fields")
        .update({ is_active: true })
        .eq("form_id", formId)
        .eq("field_key", "notes");
    });
  });

  // -------------------------------------------------------------------------
  // Reachability
  // -------------------------------------------------------------------------
  describe("form reachability", () => {
    it("returns form_not_found for an unknown slug", async () => {
      const { data } = await anonClient().rpc("vizserve_pms_submit_request", {
        p_slug: "no-such-form-anywhere",
        p_payload: completePayload(),
        p_attachments: [],
        p_ip: "10.0.0.1",
      });

      expect((data as { ok: boolean; error: string }).error).toBe("form_not_found");
    });

    it("refuses a deactivated form — a draft is not a soft launch", async () => {
      const admin = adminClient();
      await admin.from("vizserve_pms_forms").update({ is_active: false }).eq("id", formId);

      try {
        const { data } = await submit(completePayload());
        expect((data as { error: string }).error).toBe("form_not_found");
      } finally {
        await admin.from("vizserve_pms_forms").update({ is_active: true }).eq("id", formId);
      }
    });

    it("exposes only render-safe fields through the public form reader", async () => {
      // Department, SLA and author are internal. A public endpoint that leaks
      // the org chart is a small thing that compounds.
      const { data } = await anonClient().rpc("vizserve_pms_get_public_form", { p_slug: SLUG });
      const form = data as Record<string, unknown>;

      expect(form).toHaveProperty("fields");
      expect(form).not.toHaveProperty("department_id");
      expect(form).not.toHaveProperty("sla_days");
      expect(form).not.toHaveProperty("created_by");
    });
  });
});

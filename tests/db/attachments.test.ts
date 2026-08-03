import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";

import { DEPARTMENTS, adminClient, anonClient, dbTestsEnabled, skipReason } from "./helpers";

/**
 * P1-09 — attachments, asserted against the real database.
 *
 * The one that matters is "refuses a receipt belonging to another form". The
 * whole two-step handshake exists so that a submission cannot name a storage
 * object it did not upload, and this is the test that proves it rather than
 * assuming it.
 *
 * Skips with a clear reason if the P1-09 migration has not been applied, since
 * an unapplied migration otherwise reads as a pile of failing security tests.
 */

if (!dbTestsEnabled) console.warn(`\n  attachments.test.ts — ${skipReason}\n`);

const SLUG_A = `p109-a-${Math.random().toString(36).slice(2, 10)}`;
const SLUG_B = `p109-b-${Math.random().toString(36).slice(2, 10)}`;

let formA = "";
let formB = "";
let migrationApplied = false;

async function detectMigration(): Promise<boolean> {
  const { error } = await adminClient()
    .from("vizserve_pms_pending_attachments")
    .select("id")
    .limit(1);

  return !error;
}

async function makeForm(slug: string, requiresAttachment: boolean) {
  const { data, error } = await adminClient()
    .from("vizserve_pms_forms")
    .insert({
      name: `P1-09 fixture ${slug}`,
      slug,
      department_id: DEPARTMENTS.VizBytes,
      reference_prefix: "TSA",
      is_public: true,
      is_active: true,
      requires_attachment: requiresAttachment,
    })
    .select("id")
    .single();

  if (error) throw new Error(`fixture form ${slug}: ${error.message}`);
  return data!.id;
}

/**
 * Mints a receipt directly.
 *
 * The upload action itself needs a Next request context for `headers()`, so it
 * cannot run here. What these tests are about is the redemption side — whether
 * the database will believe a receipt it should not — so writing the row
 * directly is the right seam, and it is also exactly what an attacker cannot do.
 */
async function mintReceipt(formId: string, fieldKey: string | null = null) {
  const { data, error } = await adminClient()
    .from("vizserve_pms_pending_attachments")
    .insert({
      form_id: formId,
      field_key: fieldKey,
      storage_path: `pending/${formId}/${crypto.randomUUID()}/brief.pdf`,
      filename: "brief.pdf",
      mime_type: "application/pdf",
      size_bytes: 2048,
    })
    .select("id, storage_path")
    .single();

  if (error) throw new Error(`receipt: ${error.message}`);
  return data!;
}

describe.skipIf(!dbTestsEnabled)("P1-09 attachments", () => {
  beforeAll(async () => {
    migrationApplied = await detectMigration();

    if (!migrationApplied) {
      console.warn(
        "\n  attachments.test.ts — SKIPPED. supabase/migrations/20260803100000_p1_09_attachments.sql" +
          " has not been applied to this project. Apply it, then re-run.\n",
      );
      return;
    }

    formA = await makeForm(SLUG_A, false);
    formB = await makeForm(SLUG_B, true);
  });

  afterAll(async () => {
    if (!migrationApplied) return;
    const admin = adminClient();

    for (const formId of [formA, formB].filter(Boolean)) {
      await admin.from("vizserve_pms_requests").delete().eq("form_id", formId);
      await admin.from("vizserve_pms_pending_attachments").delete().eq("form_id", formId);
      await admin.from("vizserve_pms_public_submission_log").delete().eq("form_id", formId);
      await admin.from("vizserve_pms_reference_counters").delete().eq("form_id", formId);
      await admin.from("vizserve_pms_forms").delete().eq("id", formId);
    }
  });

  function submit(slug: string, attachments: unknown[], overrides: Record<string, unknown> = {}) {
    return anonClient().rpc("vizserve_pms_submit_request", {
      p_slug: slug,
      p_payload: {
        requester_name: "Juan dela Cruz",
        requester_email: `p109.${Math.random().toString(36).slice(2, 8)}@example.com`,
        title: "Attachment fixture",
        description: "Submitted by the P1-09 suite.",
        target_date: "2026-12-01",
        field_values: {},
        ...overrides,
      } as Json,
      p_attachments: attachments as Json,
      p_ip: `10.9.0.${Math.floor(Math.random() * 250)}`,
    });
  }

  // -------------------------------------------------------------------------
  // The reason the handshake exists
  // -------------------------------------------------------------------------
  describe("a submission cannot attach a file it did not upload", () => {
    it.skipIf(!migrationApplied)(
      "refuses a receipt minted against a different form",
      async () => {
        // The attack: upload one file to a form you are allowed to use, then
        // redeem the receipt against another form. Scoping the receipt to its
        // form is what closes it.
        const receipt = await mintReceipt(formB);

        const { data } = await submit(SLUG_A, [{ id: receipt.id }]);
        const requestId = (data as { request_id: string }).request_id;

        const { data: attached } = await adminClient()
          .from("vizserve_pms_request_attachments")
          .select("id")
          .eq("request_id", requestId);

        expect(attached).toEqual([]);

        // And the receipt is still unspent, i.e. not silently consumed either.
        const { data: still } = await adminClient()
          .from("vizserve_pms_pending_attachments")
          .select("id")
          .eq("id", receipt.id);
        expect(still).toHaveLength(1);
      },
    );

    it.skipIf(!migrationApplied)("ignores a fabricated storage path entirely", async () => {
      // The old shape let the payload declare {storage_path, filename, size}.
      // Under the new one those keys are not read at all, so this is not merely
      // rejected — it is unrepresentable.
      const { data } = await submit(SLUG_A, [
        {
          storage_path: "pending/somebody-elses/secret.pdf",
          filename: "secret.pdf",
          mime_type: "application/pdf",
          size_bytes: 999,
        },
      ]);

      const requestId = (data as { request_id: string }).request_id;

      const { data: attached } = await adminClient()
        .from("vizserve_pms_request_attachments")
        .select("id")
        .eq("request_id", requestId);

      expect(attached).toEqual([]);
    });

    it.skipIf(!migrationApplied)("ignores a nonexistent and a malformed id", async () => {
      const { data } = await submit(SLUG_A, [
        { id: crypto.randomUUID() },
        { id: "not-a-uuid" },
        { id: "" },
      ]);

      // Crucially the submission still SUCCEEDS. A public endpoint that 500s on
      // junk input tells an attacker more than a shrug does.
      expect((data as { ok: boolean }).ok).toBe(true);

      const { data: attached } = await adminClient()
        .from("vizserve_pms_request_attachments")
        .select("id")
        .eq("request_id", (data as { request_id: string }).request_id);

      expect(attached).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Redemption
  // -------------------------------------------------------------------------
  describe("redeeming a genuine receipt", () => {
    it.skipIf(!migrationApplied)(
      "copies the server-measured metadata, not the payload's claims",
      async () => {
        const receipt = await mintReceipt(formA, "brief");

        const { data } = await submit(SLUG_A, [
          {
            id: receipt.id,
            field_key: "brief",
            // All lies. None of them should survive.
            filename: "innocuous.txt",
            mime_type: "text/plain",
            size_bytes: 1,
          },
        ]);

        const { data: attached } = await adminClient()
          .from("vizserve_pms_request_attachments")
          .select("filename, mime_type, size_bytes, storage_path, field_key")
          .eq("request_id", (data as { request_id: string }).request_id)
          .single();

        expect(attached).toMatchObject({
          filename: "brief.pdf",
          mime_type: "application/pdf",
          size_bytes: 2048,
          storage_path: receipt.storage_path,
          field_key: "brief",
        });
      },
    );

    it.skipIf(!migrationApplied)("spends the receipt, so it cannot be reused", async () => {
      const receipt = await mintReceipt(formA);

      await submit(SLUG_A, [{ id: receipt.id }]);

      const { data: remaining } = await adminClient()
        .from("vizserve_pms_pending_attachments")
        .select("id")
        .eq("id", receipt.id);

      expect(remaining).toEqual([]);

      // A second submission naming the same receipt attaches nothing.
      const { data: second } = await submit(SLUG_A, [{ id: receipt.id }]);
      const { data: attached } = await adminClient()
        .from("vizserve_pms_request_attachments")
        .select("id")
        .eq("request_id", (second as { request_id: string }).request_id);

      expect(attached).toEqual([]);
    });

    it.skipIf(!migrationApplied)("attaches a duplicated receipt only once", async () => {
      const receipt = await mintReceipt(formA);

      const { data } = await submit(SLUG_A, [{ id: receipt.id }, { id: receipt.id }]);

      const { data: attached } = await adminClient()
        .from("vizserve_pms_request_attachments")
        .select("id")
        .eq("request_id", (data as { request_id: string }).request_id);

      expect(attached).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The requirement is counted from receipts, not from array length
  // -------------------------------------------------------------------------
  describe("a form that requires an attachment", () => {
    it.skipIf(!migrationApplied)("rejects a submission with no files", async () => {
      const { data } = await submit(SLUG_B, []);

      expect((data as { ok: boolean }).ok).toBe(false);
      expect((data as { field_errors: Record<string, string> }).field_errors).toHaveProperty(
        "attachments",
      );
    });

    it.skipIf(!migrationApplied)(
      "rejects a submission whose files are all fabricated",
      async () => {
        // The old check counted array entries the caller supplied, so a payload
        // could satisfy "requires an attachment" with an empty object.
        const { data } = await submit(SLUG_B, [{}, { id: crypto.randomUUID() }]);

        expect((data as { ok: boolean }).ok).toBe(false);
        expect((data as { field_errors: Record<string, string> }).field_errors).toHaveProperty(
          "attachments",
        );
      },
    );

    it.skipIf(!migrationApplied)("accepts a submission with a genuine receipt", async () => {
      const receipt = await mintReceipt(formB);
      const { data } = await submit(SLUG_B, [{ id: receipt.id }]);

      expect((data as { ok: boolean }).ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Reach
  // -------------------------------------------------------------------------
  describe("the pending table is unreachable", () => {
    it.skipIf(!migrationApplied)("anon cannot read it", async () => {
      const { error } = await anonClient().from("vizserve_pms_pending_attachments").select("id");
      expect(error).not.toBeNull();
    });
  });
});

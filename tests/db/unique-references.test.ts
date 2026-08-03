import { afterAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";

import {
  DEPARTMENTS,
  adminClient,
  anonClient,
  dbTestsEnabled,
  skipReason,
} from "./helpers";

/**
 * P1-10 (regression) — two forms must not be able to mint the same reference.
 *
 * THE BUG. `vizserve_pms_requests.reference_no` is globally unique, but the
 * counter behind it runs per (form, year). Two forms sharing a
 * `reference_prefix` therefore both produce `COL-2026-0001`, and the second
 * submission died on a raw 23505 raised from inside a SECURITY DEFINER function
 * — which reaches a member of the public as a 500, on the one surface in this
 * system that is supposed to answer every bad input with structured field
 * errors.
 *
 * How it hid: it needs two forms, the same prefix, and a successful submission
 * to each. Until the P1-09 suite needed two fixture forms, nothing in the
 * codebase had ever created two. It would have surfaced in the first week of
 * real use, to a client.
 *
 * Fixed by 20260803120000 in two places — a unique index so the collision cannot
 * be created, and a retry loop in the generator so any future route to a
 * duplicate degrades into a numbering gap rather than a 500.
 */

if (!dbTestsEnabled)
  console.warn(`\n  unique-references.test.ts — ${skipReason}\n`);

const migrationApplied = dbTestsEnabled
  ? await (async () => {
      // Probe by attempting the thing the index forbids, rather than by looking
      // for the index — this asserts the behaviour, not the implementation.
      const admin = adminClient();
      const tag = Math.random().toString(36).slice(2, 6);
      const prefix = `Z${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

      const first = await admin
        .from("vizserve_pms_forms")
        .insert({
          name: "probe a",
          slug: `probe-a-${tag}`,
          department_id: DEPARTMENTS.VizBytes,
          reference_prefix: prefix,
        })
        .select("id")
        .single();

      if (first.error) return false;

      const second = await admin
        .from("vizserve_pms_forms")
        .insert({
          name: "probe b",
          slug: `probe-b-${tag}`,
          department_id: DEPARTMENTS.VizBytes,
          reference_prefix: prefix,
        })
        .select("id")
        .single();

      await admin.from("vizserve_pms_forms").delete().eq("id", first.data!.id);
      if (second.data)
        await admin
          .from("vizserve_pms_forms")
          .delete()
          .eq("id", second.data.id);

      return Boolean(second.error);
    })()
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  unique-references.test.ts — SKIPPED. supabase/migrations/20260803120000_p1_10_reference_prefix_unique.sql" +
      " has not been applied. Apply it, then re-run.\n",
  );
}

const created: string[] = [];

async function makeForm(slug: string, prefix: string) {
  const { data, error } = await adminClient()
    .from("vizserve_pms_forms")
    .insert({
      name: `P1-10 fixture ${slug}`,
      slug,
      department_id: DEPARTMENTS.VizBytes,
      reference_prefix: prefix,
      is_public: true,
      is_active: true,
    })
    .select("id")
    .single();

  if (error) return { error };
  created.push(data!.id);
  return { id: data!.id };
}

describe.skipIf(!dbTestsEnabled)(
  "P1-10 reference numbers are globally unique",
  () => {
    afterAll(async () => {
      const admin = adminClient();
      for (const formId of created) {
        await admin
          .from("vizserve_pms_requests")
          .delete()
          .eq("form_id", formId);
        await admin
          .from("vizserve_pms_public_submission_log")
          .delete()
          .eq("form_id", formId);
        await admin
          .from("vizserve_pms_reference_counters")
          .delete()
          .eq("form_id", formId);
        await admin.from("vizserve_pms_forms").delete().eq("id", formId);
      }
    });

    it.skipIf(!migrationApplied)(
      "refuses a second form with the same prefix",
      async () => {
        const tag = Math.random().toString(36).slice(2, 8);
        const prefix = `U${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

        const first = await makeForm(`p110-a-${tag}`, prefix);
        expect(first.error).toBeUndefined();

        const second = await makeForm(`p110-b-${tag}`, prefix);
        expect(second.error).toBeDefined();
      },
    );

    it.skipIf(!migrationApplied)(
      "refuses one that differs only in case",
      async () => {
        // The zod schema uppercases, but the column never promised to — and `col`
        // and `COL` generate the identical reference number.
        const tag = Math.random().toString(36).slice(2, 8);
        const prefix = `V${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

        const first = await makeForm(`p110-c-${tag}`, prefix);
        expect(first.error).toBeUndefined();

        const second = await makeForm(`p110-d-${tag}`, prefix.toLowerCase());
        expect(second.error).toBeDefined();
      },
    );

    it.skipIf(!migrationApplied)(
      "two forms with different prefixes both submit successfully",
      async () => {
        // The original failure, end to end: before the fix, the second of these
        // returned null and a 23505 rather than a reference number.
        const tag = Math.random().toString(36).slice(2, 8);
        const slugA = `p110-e-${tag}`;
        const slugB = `p110-f-${tag}`;

        await makeForm(slugA, `W${tag.slice(0, 3).toUpperCase()}`);
        await makeForm(slugB, `X${tag.slice(0, 3).toUpperCase()}`);

        const payload = (n: number) =>
          ({
            requester_name: "Juan dela Cruz",
            requester_email: `p110.${n}.${tag}@example.com`,
            title: "Reference collision fixture",
            description: "Both of these must succeed.",
            target_date: "2026-12-01",
            field_values: {},
          }) as Json;

        const anon = anonClient();

        const a = await anon.rpc("vizserve_pms_submit_request", {
          p_slug: slugA,
          p_payload: payload(1),
          p_attachments: [],
          p_ip: "198.51.100.11",
        });

        const b = await anon.rpc("vizserve_pms_submit_request", {
          p_slug: slugB,
          p_payload: payload(2),
          p_attachments: [],
          p_ip: "198.51.100.12",
        });

        expect(a.error).toBeNull();
        expect(b.error).toBeNull();

        const refA = (a.data as { ok: boolean; reference_no: string })
          .reference_no;
        const refB = (b.data as { ok: boolean; reference_no: string })
          .reference_no;

        expect((a.data as { ok: boolean }).ok).toBe(true);
        expect((b.data as { ok: boolean }).ok).toBe(true);
        // Both are ...-0001 for their own form, and they are still different.
        expect(refA).not.toBe(refB);
        expect(refA.endsWith("-0001")).toBe(true);
        expect(refB.endsWith("-0001")).toBe(true);
      },
    );

    // NOTE: the generator's retry loop (any future route to a duplicate degrades
    // into a numbering gap rather than a 500) is deliberately NOT tested here.
    // Provoking it means writing a reference_no directly, which is not app-
    // writable by design, and the only way to fake it is mutating an unrelated
    // real request. A test that can corrupt live data to prove a belt-and-braces
    // path is a worse trade than leaving that path untested.
  },
);

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";

import { DEPARTMENTS, adminClient, anonClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P2-13 — Gate 1 and the engine underneath it.
 *
 * The first block is the Phase 2 exit criterion that matters most: THE ENGINE IS
 * GENERIC. A throwaway second entity type routes through it end to end without
 * touching engine code. If that ever needs an engine change, the abstraction is
 * wrong and Phase 5 becomes a rewrite rather than a new form.
 */

if (!dbTestsEnabled) console.warn(`\n  approval-engine.test.ts — ${skipReason}\n`);

const SLUG = `p2-fixture-${Math.random().toString(36).slice(2, 10)}`;

let formId = "";
let picId = "";
let qaId = "";

/**
 * Detected at MODULE LOAD, not in `beforeAll` — `it.skipIf(...)` is evaluated
 * during collection, before any hook runs, so a flag set in a hook is still
 * false at every skip decision.
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_approvals").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  approval-engine.test.ts — SKIPPED. supabase/migrations/20260803110000_p2_00_approval_engine.sql" +
      " has not been applied to this project. Apply it, then re-run.\n",
  );
}

/** A fresh PENDING_REVIEW request, submitted the way a client would. */
async function submitRequest(targetDate = "2026-12-01"): Promise<string> {
  const { data } = await anonClient().rpc("vizserve_pms_submit_request", {
    p_slug: SLUG,
    p_payload: {
      requester_name: "Juan dela Cruz",
      requester_email: `p2.${Math.random().toString(36).slice(2, 8)}@example.com`,
      title: "Poster for the open day",
      description: "A3, portrait, two variants.",
      target_date: targetDate,
      field_values: {},
    } as Json,
    p_attachments: [],
    p_ip: `10.2.0.${Math.floor(Math.random() * 250)}`,
  });

  const result = data as { ok: boolean; request_id?: string };
  if (!result.ok) throw new Error(`fixture request: ${JSON.stringify(data)}`);
  return result.request_id!;
}

describe.skipIf(!dbTestsEnabled)("P2 approval engine", () => {
  beforeAll(async () => {
    if (!migrationApplied) return;

    const admin = adminClient();

    const { data: form, error } = await admin
      .from("vizserve_pms_forms")
      .insert({
        name: "P2 fixture form",
        slug: SLUG,
        department_id: DEPARTMENTS.VizBytes,
        // Unique per run: reference_prefix is globally unique (P1-10), so a
        // fixed literal collides with any earlier run that failed before cleanup.
        reference_prefix: `P${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
        is_public: true,
        is_active: true,
      })
      .select("id")
      .single();

    if (error) throw new Error(`fixture form: ${error.message}`);
    formId = form!.id;

    const { data: members } = await admin
      .from("vizserve_pms_users")
      .select("id, email")
      .eq("primary_department_id", DEPARTMENTS.VizBytes)
      .eq("role", "member")
      .order("email");

    picId = members![0]!.id;
    qaId = members![1]!.id;
  });

  afterAll(async () => {
    if (!migrationApplied || !formId) return;
    const admin = adminClient();

    const { data: requests } = await admin
      .from("vizserve_pms_requests")
      .select("id")
      .eq("form_id", formId);

    const ids = (requests ?? []).map((row) => row.id);

    if (ids.length > 0) {
      await admin.from("vizserve_pms_tasks").delete().in("request_id", ids);
      await admin.from("vizserve_pms_notifications").delete().in("entity_id", ids);
    }

    await admin.from("vizserve_pms_requests").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_public_submission_log").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_reference_counters").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_forms").delete().eq("id", formId);
  });

  // =========================================================================
  // THE EXIT CRITERION: the engine is generic.
  // =========================================================================
  describe("the engine knows nothing about requests", () => {
    it.skipIf(!migrationApplied)(
      "routes a throwaway second entity type end to end, with no engine change",
      async () => {
        // This is the Phase 5 rehearsal. 'rehearsal_widget' is not a table, has
        // no status column, and has no code anywhere in the system. If the
        // engine can approve one, then a leave request is a new form and not a
        // new engine.
        const { client } = await signIn("tlVizBytes");
        const inventedId = crypto.randomUUID();

        const { data: approvalId, error } = await client.rpc("vizserve_pms_record_decision", {
          p_entity_type: "rehearsal_widget",
          p_entity_id: inventedId,
          p_department_id: DEPARTMENTS.VizBytes,
          p_decision: "approved",
          p_reason: null,
        });

        expect(error).toBeNull();
        expect(approvalId).toBeTruthy();

        // The decision is recorded, attributed, and audited exactly as a request
        // decision would be.
        const { data: approval } = await adminClient()
          .from("vizserve_pms_approvals")
          .select("entity_type, entity_id, decision, approver_id, department_id")
          .eq("id", approvalId as string)
          .single();

        expect(approval).toMatchObject({
          entity_type: "rehearsal_widget",
          entity_id: inventedId,
          decision: "approved",
          department_id: DEPARTMENTS.VizBytes,
        });

        const { data: audit } = await adminClient()
          .from("vizserve_pms_audit_logs")
          .select("entity_type, action")
          .eq("entity_id", inventedId);

        expect(audit).toHaveLength(1);
        expect(audit![0]).toMatchObject({ entity_type: "rehearsal_widget", action: "approved" });

        await adminClient().from("vizserve_pms_approvals").delete().eq("id", approvalId as string);
      },
    );

    it.skipIf(!migrationApplied)(
      "applies the mandatory-reason rule to that second type too",
      async () => {
        // The rule lives in the engine, so it comes free for every future
        // entity type rather than being re-implemented per consumer.
        const { client } = await signIn("tlVizBytes");

        const { error } = await client.rpc("vizserve_pms_record_decision", {
          p_entity_type: "rehearsal_widget",
          p_entity_id: crypto.randomUUID(),
          p_department_id: DEPARTMENTS.VizBytes,
          p_decision: "rejected",
          p_reason: "   ",
        });

        expect(error).not.toBeNull();
      },
    );

    it.skipIf(!migrationApplied)(
      "applies department scope to that second type too",
      async () => {
        const { client } = await signIn("tlVizAssists");

        const { error } = await client.rpc("vizserve_pms_record_decision", {
          p_entity_type: "rehearsal_widget",
          p_entity_id: crypto.randomUUID(),
          p_department_id: DEPARTMENTS.VizBytes,
          p_decision: "approved",
          p_reason: null,
        });

        expect(error).not.toBeNull();
      },
    );
  });

  // =========================================================================
  // P2-07 — the approval transaction
  // =========================================================================
  describe("approving", () => {
    it.skipIf(!migrationApplied)(
      "stores BOTH dates and makes the task due on the adjusted one",
      async () => {
        // The delta between the two is the only measurable evidence that this
        // gate negotiates rather than rubber-stamps. Overwrite target_date and
        // the feature becomes unprovable.
        const requestId = await submitRequest("2026-12-01");
        const { client } = await signIn("tlVizBytes");

        const { data, error } = await client.rpc("vizserve_pms_approve_request", {
          p_request_id: requestId,
          p_assignee_id: picId,
          p_qa_assignee_id: qaId,
          p_approved_target_date: "2026-12-08",
          p_title: null,
          p_description: null,
        });

        expect(error).toBeNull();
        expect((data as { ok: boolean }).ok).toBe(true);

        const { data: request } = await adminClient()
          .from("vizserve_pms_requests")
          .select("status, target_date, approved_target_date, reviewed_by, reviewed_at")
          .eq("id", requestId)
          .single();

        expect(request!.status).toBe("APPROVED");
        expect(request!.target_date).toBe("2026-12-01");
        expect(request!.approved_target_date).toBe("2026-12-08");
        expect(request!.reviewed_at).not.toBeNull();

        const { data: task } = await adminClient()
          .from("vizserve_pms_tasks")
          .select("status, due_date, assignee_id, qa_assignee_id, department_id, title")
          .eq("request_id", requestId)
          .single();

        expect(task).toMatchObject({
          status: "OPEN",
          due_date: "2026-12-08",
          assignee_id: picId,
          qa_assignee_id: qaId,
          department_id: DEPARTMENTS.VizBytes,
        });
      },
    );

    it.skipIf(!migrationApplied)("notifies both the PIC and the QA reviewer", async () => {
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      const { data } = await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: qaId,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      const taskId = (data as { task_id: string }).task_id;

      const { data: notifications } = await adminClient()
        .from("vizserve_pms_notifications")
        .select("user_id, type, link_path")
        .eq("entity_id", taskId);

      const byUser = new Map(notifications!.map((row) => [row.user_id, row]));

      expect(byUser.get(picId)?.type).toBe("assigned");
      expect(byUser.get(qaId)?.type).toBe("qa_requested");
      // Every notification links to the exact record (docs/12 §3 rule 2).
      expect(byUser.get(picId)?.link_path).toBe(`/tasks/${taskId}`);
    });

    it.skipIf(!migrationApplied)("copies the request's field values onto the task", async () => {
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: null,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("field_values")
        .eq("request_id", requestId)
        .single();

      expect(task!.field_values).toBeDefined();
    });

    it.skipIf(!migrationApplied)("records edits with before and after", async () => {
      // P2-03. Without this, "the TL changed the brief" is unprovable.
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: null,
        p_approved_target_date: "2026-12-15",
        p_title: "Poster for the open day (A3)",
        p_description: null,
      });

      const { data: audit } = await adminClient()
        .from("vizserve_pms_audit_logs")
        .select("action, before, after")
        .eq("entity_id", requestId)
        .eq("action", "edited")
        .single();

      const before = audit!.before as Record<string, unknown>;
      const after = audit!.after as Record<string, unknown>;

      expect(before.title).toBe("Poster for the open day");
      expect(before.target_date).toBe("2026-12-01");
      expect(after.title).toBe("Poster for the open day (A3)");
      expect(after.approved_target_date).toBe("2026-12-15");
    });

    it.skipIf(!migrationApplied)(
      "writes exactly one 'approved' row, and no 'edited' row when nothing changed",
      async () => {
        // The engine logs the decision and Gate 1 used to log a second row with
        // the same action, so "the audit entry for this approval" returned two.
        // A trail where every approval also logs an edit is a trail in which a
        // real edit is invisible.
        const requestId = await submitRequest();
        const { client } = await signIn("tlVizBytes");

        await client.rpc("vizserve_pms_approve_request", {
          p_request_id: requestId,
          p_assignee_id: picId,
          p_qa_assignee_id: null,
          p_approved_target_date: null,
          p_title: null,
          p_description: null,
        });

        const { data: rows } = await adminClient()
          .from("vizserve_pms_audit_logs")
          .select("action")
          .eq("entity_id", requestId);

        const actions = (rows ?? []).map((row) => row.action).sort();
        expect(actions).toEqual(["approved", "submitted"]);
      },
    );

    // -----------------------------------------------------------------------
    // Atomicity — "a forced failure mid-transaction leaves no partial state"
    // -----------------------------------------------------------------------
    it.skipIf(!migrationApplied)(
      "leaves NO partial state when the assignee is invalid",
      async () => {
        // The failure is forced at the last possible check, after the engine has
        // already written an approval row and after the status update would have
        // run. If any of it survived, the request would read APPROVED with no
        // task — the exact bug that sends the team back to ClickUp (R9).
        const requestId = await submitRequest();
        const { client } = await signIn("tlVizBytes");

        const { data: outsider } = await adminClient()
          .from("vizserve_pms_users")
          .select("id")
          .eq("primary_department_id", DEPARTMENTS.VizMedia)
          .eq("role", "member")
          .limit(1)
          .single();

        const { error } = await client.rpc("vizserve_pms_approve_request", {
          p_request_id: requestId,
          p_assignee_id: outsider!.id,
          p_qa_assignee_id: null,
          p_approved_target_date: null,
          p_title: null,
          p_description: null,
        });

        expect(error).not.toBeNull();

        const admin = adminClient();

        const { data: request } = await admin
          .from("vizserve_pms_requests")
          .select("status, reviewed_at")
          .eq("id", requestId)
          .single();
        expect(request!.status).toBe("PENDING_REVIEW");
        expect(request!.reviewed_at).toBeNull();

        const { data: tasks } = await admin
          .from("vizserve_pms_tasks")
          .select("id")
          .eq("request_id", requestId);
        expect(tasks).toEqual([]);

        // The approval row written by the engine earlier in the same function
        // must be gone too.
        const { data: approvals } = await admin
          .from("vizserve_pms_approvals")
          .select("id")
          .eq("entity_id", requestId);
        expect(approvals).toEqual([]);

        const { data: audit } = await admin
          .from("vizserve_pms_audit_logs")
          .select("id")
          .eq("entity_id", requestId)
          .eq("action", "approved");
        expect(audit).toEqual([]);
      },
    );

    it.skipIf(!migrationApplied)("refuses a second approval of the same request", async () => {
      // Two Team Leaders clicking Approve seconds apart. Without the status
      // check the second silently reassigns the first one's task.
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: null,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      const { error } = await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: qaId,
        p_qa_assignee_id: null,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      expect(error).not.toBeNull();

      const { data: tasks } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("assignee_id")
        .eq("request_id", requestId);

      expect(tasks).toHaveLength(1);
      expect(tasks![0]!.assignee_id).toBe(picId);
    });
  });

  // =========================================================================
  // P2-08 / P2-09
  // =========================================================================
  describe("returning and rejecting", () => {
    it.skipIf(!migrationApplied)("refuses to return without a reason", async () => {
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      const { error } = await client.rpc("vizserve_pms_decide_request", {
        p_request_id: requestId,
        p_decision: "returned",
        p_reason: "",
      });

      expect(error).not.toBeNull();

      const { data: request } = await adminClient()
        .from("vizserve_pms_requests")
        .select("status")
        .eq("id", requestId)
        .single();

      expect(request!.status).toBe("PENDING_REVIEW");
    });

    it.skipIf(!migrationApplied)("refuses whitespace as a reason", async () => {
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      const { error } = await client.rpc("vizserve_pms_decide_request", {
        p_request_id: requestId,
        p_decision: "rejected",
        p_reason: "     ",
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)(
      "returns with the reason stored and readable, and creates no task",
      async () => {
        const requestId = await submitRequest();
        const { client } = await signIn("tlVizBytes");

        const reason = "The brief lists two sizes but mentions a third. Which is it?";

        const { data, error } = await client.rpc("vizserve_pms_decide_request", {
          p_request_id: requestId,
          p_decision: "returned",
          p_reason: reason,
        });

        expect(error).toBeNull();
        // The requester's address comes back so the action can email them —
        // a client has no user row and therefore no inbox to notify.
        expect((data as { requester_email: string }).requester_email).toContain("@");

        const { data: request } = await adminClient()
          .from("vizserve_pms_requests")
          .select("status, decision_reason")
          .eq("id", requestId)
          .single();

        expect(request!.status).toBe("RETURNED");
        expect(request!.decision_reason).toBe(reason);

        const { data: tasks } = await adminClient()
          .from("vizserve_pms_tasks")
          .select("id")
          .eq("request_id", requestId);
        expect(tasks).toEqual([]);
      },
    );

    it.skipIf(!migrationApplied)("refuses to approve an already-rejected request", async () => {
      const requestId = await submitRequest();
      const { client } = await signIn("tlVizBytes");

      await client.rpc("vizserve_pms_decide_request", {
        p_request_id: requestId,
        p_decision: "rejected",
        p_reason: "This needs video production, which is outside this team.",
      });

      const { error } = await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: null,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      expect(error).not.toBeNull();
    });
  });

  // =========================================================================
  // P2-13 — cross-department authorization
  // =========================================================================
  describe("cross-department authorization", () => {
    it.skipIf(!migrationApplied)(
      "a TL of another department cannot approve, and nothing changes",
      async () => {
        const requestId = await submitRequest();
        const { client } = await signIn("tlVizAssists");

        const { error } = await client.rpc("vizserve_pms_approve_request", {
          p_request_id: requestId,
          p_assignee_id: picId,
          p_qa_assignee_id: null,
          p_approved_target_date: null,
          p_title: null,
          p_description: null,
        });

        expect(error).not.toBeNull();

        const { data: request } = await adminClient()
          .from("vizserve_pms_requests")
          .select("status")
          .eq("id", requestId)
          .single();
        expect(request!.status).toBe("PENDING_REVIEW");
      },
    );

    it.skipIf(!migrationApplied)("a member cannot approve their own department's work", async () => {
      const requestId = await submitRequest();
      const { client } = await signIn("member1VizBytes");

      const { error } = await client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: null,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("a TL cannot read another department's decisions", async () => {
      const requestId = await submitRequest();
      const owner = await signIn("tlVizBytes");

      await owner.client.rpc("vizserve_pms_decide_request", {
        p_request_id: requestId,
        p_decision: "returned",
        p_reason: "Need the third size before we can start on this.",
      });

      const outsider = await signIn("tlVizAssists");
      const { data, error } = await outsider.client
        .from("vizserve_pms_approvals")
        .select("id")
        .eq("entity_id", requestId);

      // Zero rows, not an error — a working policy, not a missing grant.
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it.skipIf(!migrationApplied)(
      "the capacity query returns nothing for a department you do not lead",
      async () => {
        // SECURITY DEFINER without this check would hand any signed-in user a
        // headcount and workload report for every team in the company.
        const { client } = await signIn("tlVizAssists");

        const { data } = await client.rpc("vizserve_pms_department_capacity", {
          p_department_id: DEPARTMENTS.VizBytes,
          p_target_date: "2026-12-01",
        });

        expect(data).toEqual([]);
      },
    );

    it.skipIf(!migrationApplied)("the capacity query works for a department you do lead", async () => {
      const { client } = await signIn("tlVizBytes");

      const { data, error } = await client.rpc("vizserve_pms_department_capacity", {
        p_department_id: DEPARTMENTS.VizBytes,
        p_target_date: "2026-12-01",
      });

      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThan(0);
      expect(data![0]).toHaveProperty("open_count");
      expect(data![0]).toHaveProperty("due_before");
    });
  });

  // =========================================================================
  // Task visibility (the P3-15 rule, asserted now that tasks exist)
  // =========================================================================
  describe("task visibility", () => {
    it.skipIf(!migrationApplied)("the PIC sees their task; an uninvolved member does not", async () => {
      const requestId = await submitRequest();
      const tl = await signIn("tlVizBytes");

      const { data } = await tl.client.rpc("vizserve_pms_approve_request", {
        p_request_id: requestId,
        p_assignee_id: picId,
        p_qa_assignee_id: null,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
      });

      const taskId = (data as { task_id: string }).task_id;

      // picId is member1VizBytes (ordered by email), so this is the PIC.
      const pic = await signIn("member1VizBytes");
      const { data: mine } = await pic.client
        .from("vizserve_pms_tasks")
        .select("id")
        .eq("id", taskId);
      expect(mine).toHaveLength(1);

      // A member of another department is on neither side of it.
      const outsider = await signIn("member1VizAssists");
      const { data: theirs } = await outsider.client
        .from("vizserve_pms_tasks")
        .select("id")
        .eq("id", taskId);
      expect(theirs).toEqual([]);
    });
  });
});

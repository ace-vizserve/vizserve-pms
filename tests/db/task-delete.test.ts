import { afterAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";

import { DEPARTMENTS, adminClient, anonClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P7-19 — deleting an internal task.
 *
 * ⚠️ WRITTEN BEFORE THE MIGRATION WAS PASTED, like `task-groups.test.ts`, and
 * for the same reason: plpgsql resolves the functions a body calls at first
 * execution, so a migration full of SECURITY DEFINER functions can apply
 * cleanly and be broken on every path. P7-16 proved that twice in one day.
 *
 * The cases that matter most here are the REFUSALS. A delete button that works
 * is obvious the first time anyone presses it; a delete button that quietly
 * removes a client's approval record, or twenty hours of somebody's logged time,
 * is not obvious until payroll asks.
 */

function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`task-delete.test.ts — ${skipReason}`);

/** Probed on the function, since that is the whole migration. */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().rpc("vizserve_pms_can_delete_task" as never, { p_task_id: null } as never))
      .error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "task-delete.test.ts — SKIPPED." +
      " supabase/migrations/20260819140000_p7_19_delete_internal_task.sql is not applied." +
      " Apply it in the dashboard SQL editor, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const REQUEST_SLUG = `p7-19-${Math.random().toString(36).slice(2, 8)}`;

const created: string[] = [];
const createdRequests: string[] = [];
let formId = "";
let picId = "";
let qaId = "";

type Client = Awaited<ReturnType<typeof signIn>>["client"];

/** A fresh internal task in VizBytes, created by whoever is passed in. */
async function makeTask(client: Client, overrides: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc("vizserve_pms_create_task", {
    p_department_id: DEPARTMENTS.VizBytes,
    p_title: `P7-19 fixture ${Math.random().toString(36).slice(2, 8)}`,
    p_description: "Created by the delete suite.",
    p_assignee_id: picId,
    p_qa_assignee_id: null,
    p_due_date: null,
    p_list_id: null,
    ...overrides,
  });

  if (error) throw new Error(`fixture task: ${error.message}`);
  const id = (data as { task_id: string }).task_id;
  created.push(id);
  return id;
}

/** A task with a real client request behind it — the kind that must NOT delete. */
async function makeClientTask() {
  const { data: submitted } = await anonClient().rpc("vizserve_pms_submit_request", {
    p_slug: REQUEST_SLUG,
    p_payload: {
      requester_name: "Juan dela Cruz",
      requester_email: `p7.19.${Math.random().toString(36).slice(2, 8)}@example.com`,
      title: "Poster for the open day",
      description: "A3, portrait.",
      target_date: "2026-12-01",
      field_values: {},
    } as Json,
    p_attachments: [],
    p_ip: `10.19.0.${Math.floor(Math.random() * 250)}`,
  });

  const submission = submitted as { ok: boolean; request_id?: string };
  if (!submission.ok) throw new Error(`fixture request: ${JSON.stringify(submitted)}`);
  createdRequests.push(submission.request_id!);

  const { client } = await signIn("tlVizBytes");
  const { data, error } = await client.rpc("vizserve_pms_approve_request", {
    p_request_id: submission.request_id!,
    p_assignee_id: picId,
    p_qa_assignee_id: qaId,
    p_approved_target_date: null,
    p_title: null,
    p_description: null,
    p_list_id: null,
  });

  if (error) throw new Error(`fixture approval: ${error.message}`);
  const id = (data as { task_id: string }).task_id;
  created.push(id);
  return id;
}

async function exists(taskId: string) {
  const { data } = await adminClient()
    .from("vizserve_pms_tasks")
    .select("id")
    .eq("id", taskId)
    .maybeSingle();
  return data !== null;
}

if (run) {
  const { data: members } = await adminClient()
    .from("vizserve_pms_users")
    .select("id, email")
    .in("email", ["test.member1.vizbytes@example.com", "test.member2.vizbytes@example.com"])
    .order("email");

  picId = members![0]!.id;
  qaId = members![1]!.id;

  const { data: form, error } = await adminClient()
    .from("vizserve_pms_forms")
    .insert({
      name: `P7-19 fixture form ${REQUEST_SLUG}`,
      slug: REQUEST_SLUG,
      department_id: DEPARTMENTS.VizBytes,
      reference_prefix: `D${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      is_public: true,
      is_active: true,
    })
    .select("id")
    .single();

  if (error) throw new Error(`fixture form: ${error.message}`);
  formId = form!.id;
}

afterAll(async () => {
  if (!run) return;
  const admin = adminClient();

  if (created.length > 0) {
    await admin.from("vizserve_pms_notifications").delete().in("entity_id", created);
    await admin.from("vizserve_pms_tasks").delete().in("id", created);
  }
  if (createdRequests.length > 0) {
    await admin.from("vizserve_pms_notifications").delete().in("entity_id", createdRequests);
    await admin.from("vizserve_pms_requests").delete().in("id", createdRequests);
  }
  // The form last — P7-18 gave it an inbox list, which cascades with it.
  if (formId) await admin.from("vizserve_pms_forms").delete().eq("id", formId);
});

// ---------------------------------------------------------------------------
// The refusals — the whole reason this is a function and not a policy
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-19 — what cannot be deleted", () => {
  it("refuses a task that came from a client request", async () => {
    /*
     * THE ONE THAT MATTERS. A request-backed task carries the client's Gate 3
     * decision, its approval token and its feedback, all of which cascade. This
     * is why the whole feature is scoped to internal work.
     */
    const taskId = await makeClientTask();
    const tl = await signIn("tlVizBytes");

    const { error } = await tl.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    expect(error?.message ?? "").toMatch(/client request/i);
    expect(await exists(taskId)).toBe(true);
  });

  it("refuses it even for an admin", async () => {
    // Not a permission rule. The shape of the record forbids it, so seniority
    // cannot buy past it.
    const taskId = await makeClientTask();
    const admin = await signIn("admin");

    const { error } = await admin.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    expect(error?.message ?? "").toMatch(/client request/i);
    expect(await exists(taskId)).toBe(true);
  });

  it("refuses a colleague who can only SEE the task", async () => {
    // P7-17 let every member of a department read its work. Delete is further
    // than update, and update was deliberately not widened.
    const tl = await signIn("tlVizBytes");
    const taskId = await makeTask(tl.client);

    const other = await signIn("member2VizBytes");
    const { data: visible } = await other.client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", taskId);
    expect(visible).toHaveLength(1); // they can see it…

    const { error } = await other.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });
    expect(error?.message ?? "").toMatch(/team leader|created/i); // …and not delete it
    expect(await exists(taskId)).toBe(true);
  });

  it("refuses a lead of another department", async () => {
    const tl = await signIn("tlVizBytes");
    const taskId = await makeTask(tl.client);

    const outsider = await signIn("tlVizMedia");
    const { error } = await outsider.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    expect(error).not.toBeNull();
    expect(await exists(taskId)).toBe(true);
  });

  it("leaves a direct DELETE through the API affecting nothing", async () => {
    /*
     * NO DELETE POLICY EXISTS, and this asserts that it stays that way. A policy
     * would be a second route in that skips the audit row and the request_id
     * guard — the function is meant to be the only door.
     */
    const tl = await signIn("tlVizBytes");
    const taskId = await makeTask(tl.client);

    const { data, error } = await tl.client
      .from("vizserve_pms_tasks")
      .delete()
      .eq("id", taskId)
      .select("id");

    // Zero rows and no error is a policy refusing; `permission denied` would be
    // a missing grant, which is a different bug.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
    expect(await exists(taskId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The deletes that should work
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-19 — who can delete", () => {
  it("lets a lead of the department delete an internal task", async () => {
    const tl = await signIn("tlVizBytes");
    const taskId = await makeTask(tl.client);

    const { error } = await tl.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    expect(error).toBeNull();
    expect(await exists(taskId)).toBe(false);
  });

  it("lets a member delete a task they created themselves", async () => {
    // P7-14 lets a member create a task. A capability to create with no way to
    // undo is how a board fills with typos nobody can remove.
    const member = await signIn("member1VizBytes");
    const taskId = await makeTask(member.client, { p_assignee_id: picId });

    const { error } = await member.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    expect(error).toBeNull();
    expect(await exists(taskId)).toBe(false);
  });

  it("lets somebody delete their own personal task", async () => {
    const member = await signIn("member1VizBytes");
    const { data } = await member.client.rpc("vizserve_pms_create_personal_task", {
      p_title: `P7-19 personal ${Math.random().toString(36).slice(2, 8)}`,
      p_description: "",
      p_due_date: null,
      p_list_id: null,
    });

    const taskId = (data as { task_id: string }).task_id;
    created.push(taskId);

    const { error } = await member.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    expect(error).toBeNull();
    expect(await exists(taskId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The damage, named before it happens
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-19 — the impact report", () => {
  it("counts the whole subtree, not just the task itself", async () => {
    /*
     * THE SURPRISE THIS EXISTS TO PREVENT. A parent reporting its own two hours
     * while silently deleting twenty from beneath it is exactly what makes a
     * delete button dangerous.
     */
    const tl = await signIn("tlVizBytes");
    const parent = await makeTask(tl.client);
    const child = await makeTask(tl.client);

    await adminClient()
      .from("vizserve_pms_tasks")
      .update({ parent_task_id: parent })
      .eq("id", child);

    // Hours on the CHILD only, so the parent's own total is zero.
    await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .insert({ user_id: picId, task_id: child, work_date: "2026-12-03", minutes: 150 } as never);

    const { data, error } = await tl.client.rpc("vizserve_pms_task_delete_impact", {
      p_task_id: parent,
    });

    expect(error).toBeNull();
    const impact = data as unknown as {
      ok: boolean;
      subtasks: number;
      tracked_minutes: number;
    };

    expect(impact.ok).toBe(true);
    expect(impact.subtasks).toBe(1);
    expect(impact.tracked_minutes).toBe(150);

    await adminClient().from("vizserve_pms_timesheet_entries").delete().eq("task_id", child);
  });

  it("takes the subtasks with it when the parent goes", async () => {
    const tl = await signIn("tlVizBytes");
    const parent = await makeTask(tl.client);
    const child = await makeTask(tl.client);

    await adminClient()
      .from("vizserve_pms_tasks")
      .update({ parent_task_id: parent })
      .eq("id", child);

    const { error } = await tl.client.rpc("vizserve_pms_delete_task", { p_task_id: parent });
    expect(error).toBeNull();

    // The cascade, asserted rather than assumed — it is the part the dialog
    // promises and the part nobody sees happen.
    expect(await exists(parent)).toBe(false);
    expect(await exists(child)).toBe(false);
  });

  it("explains itself rather than erroring on a task it will not delete", async () => {
    // The dialog calls this on open, so a refusal has to arrive as a SENTENCE it
    // can render, not as a thrown error it has to catch and translate.
    const taskId = await makeClientTask();
    const tl = await signIn("tlVizBytes");

    const { data, error } = await tl.client.rpc("vizserve_pms_task_delete_impact", {
      p_task_id: taskId,
    });

    expect(error).toBeNull();
    const impact = data as unknown as { ok: boolean; reason: string };
    expect(impact.ok).toBe(false);
    expect(impact.reason).toMatch(/client request/i);
  });
});

// ---------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-19 — the audit row", () => {
  it("records the deletion with what it destroyed", async () => {
    /*
     * Written BEFORE the row goes, because afterwards there is nothing left to
     * count. "A task was deleted" without the hours attached to it is a log
     * entry nobody can act on.
     */
    const tl = await signIn("tlVizBytes");
    const taskId = await makeTask(tl.client);

    await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .insert({ user_id: picId, task_id: taskId, work_date: "2026-12-03", minutes: 90 } as never);

    const { error } = await tl.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });
    expect(error).toBeNull();

    const { data: log } = await adminClient()
      .from("vizserve_pms_audit_logs")
      .select("action, before, after, actor_id")
      .eq("entity_id", taskId)
      .eq("action", "deleted")
      .maybeSingle();

    expect(log).not.toBeNull();
    expect(log!.actor_id).toBe(tl.userId);
    // The impact went into the after-image, so the hours survive the row.
    expect((log!.after as { tracked_minutes?: number }).tracked_minutes).toBe(90);

    await adminClient().from("vizserve_pms_audit_logs").delete().eq("entity_id", taskId);
  });

  it("clears notifications that would point at nothing", async () => {
    const tl = await signIn("tlVizBytes");
    const taskId = await makeTask(tl.client);

    await adminClient().from("vizserve_pms_notifications").insert({
      user_id: picId,
      type: "assigned",
      title: "P7-19 notification fixture",
      body: "",
      entity_type: "task",
      entity_id: taskId,
      link_path: `/tasks/${taskId}`,
    } as never);

    await tl.client.rpc("vizserve_pms_delete_task", { p_task_id: taskId });

    const { data: left } = await adminClient()
      .from("vizserve_pms_notifications")
      .select("id")
      .eq("entity_id", taskId);

    // An inbox row that opens onto a 404 is the bug docs/13 already records once.
    expect(left ?? []).toHaveLength(0);

    await adminClient().from("vizserve_pms_audit_logs").delete().eq("entity_id", taskId);
  });
});

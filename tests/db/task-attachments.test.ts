import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEPARTMENTS, adminClient, anonClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P3-13 — task output files.
 *
 * The upload action itself needs a Next request context, so what is asserted
 * here is the half that decides who can see and remove what: the RLS rules. The
 * bytes-measuring half is covered by `tests/unit/attachments.test.ts`.
 */

if (!dbTestsEnabled) console.warn(`\n  task-attachments.test.ts — ${skipReason}\n`);

const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_task_attachments").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  task-attachments.test.ts — SKIPPED. supabase/migrations/20260804090000_p3_13_task_attachments.sql" +
      " has not been applied. Apply it, then re-run.\n",
  );
}

const createdTasks: string[] = [];
let taskId = "";
let picId = "";
let qaId = "";

async function attach(task: string, uploadedBy: string | null) {
  const { data, error } = await adminClient()
    .from("vizserve_pms_task_attachments")
    .insert({
      task_id: task,
      storage_path: `tasks/${task}/${crypto.randomUUID()}/output.pdf`,
      filename: "output.pdf",
      mime_type: "application/pdf",
      size_bytes: 4096,
      uploaded_by: uploadedBy,
    })
    .select("id")
    .single();

  if (error) throw new Error(`fixture attachment: ${error.message}`);
  return data!.id;
}

describe.skipIf(!dbTestsEnabled)("P3-13 task attachments", () => {
  beforeAll(async () => {
    if (!migrationApplied) return;

    const { data: members } = await adminClient()
      .from("vizserve_pms_users")
      .select("id, email")
      .eq("primary_department_id", DEPARTMENTS.VizBytes)
      .eq("role", "member")
      .order("email");

    picId = members![0]!.id;
    qaId = members![1]!.id;

    const { client } = await signIn("tlVizBytes");
    const { data, error } = await client.rpc("vizserve_pms_create_task", {
      p_department_id: DEPARTMENTS.VizBytes,
      p_title: `P3-13 fixture ${Math.random().toString(36).slice(2, 8)}`,
      p_description: "",
      p_assignee_id: picId,
      p_qa_assignee_id: qaId,
      p_due_date: null,
      p_list_id: null,
    });

    if (error) throw new Error(`fixture task: ${error.message}`);
    taskId = (data as { task_id: string }).task_id;
    createdTasks.push(taskId);
  });

  afterAll(async () => {
    if (createdTasks.length === 0) return;
    const admin = adminClient();
    await admin.from("vizserve_pms_notifications").delete().in("entity_id", createdTasks);
    // Attachments cascade with the task.
    await admin.from("vizserve_pms_tasks").delete().in("id", createdTasks);
  });

  it.skipIf(!migrationApplied)("are visible to the PIC and the QA reviewer", async () => {
    const attachmentId = await attach(taskId, picId);

    for (const account of ["member1VizBytes", "member2VizBytes", "tlVizBytes"] as const) {
      const { client } = await signIn(account);
      const { data } = await client
        .from("vizserve_pms_task_attachments")
        .select("id")
        .eq("id", attachmentId);

      expect(data, `${account} should see it`).toHaveLength(1);
    }
  });

  it.skipIf(!migrationApplied)("are invisible outside the task", async () => {
    const attachmentId = await attach(taskId, picId);

    // A member of another department is on neither side of this task.
    const outsider = await signIn("member1VizAssists");
    const { data, error } = await outsider.client
      .from("vizserve_pms_task_attachments")
      .select("id")
      .eq("id", attachmentId);

    // Zero rows, not an error — a working policy, not a missing grant.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const foreignLead = await signIn("tlVizAssists");
    const { data: theirs } = await foreignLead.client
      .from("vizserve_pms_task_attachments")
      .select("id")
      .eq("id", attachmentId);
    expect(theirs).toEqual([]);
  });

  it.skipIf(!migrationApplied)("are unreachable to anon", async () => {
    const { error } = await anonClient().from("vizserve_pms_task_attachments").select("id");
    expect(error).not.toBeNull();
  });

  it.skipIf(!migrationApplied)("can be removed by whoever uploaded them", async () => {
    const attachmentId = await attach(taskId, picId);
    const { client } = await signIn("member1VizBytes");

    await client.from("vizserve_pms_task_attachments").delete().eq("id", attachmentId);

    const { data } = await adminClient()
      .from("vizserve_pms_task_attachments")
      .select("id")
      .eq("id", attachmentId);
    expect(data).toEqual([]);
  });

  it.skipIf(!migrationApplied)("cannot be removed by someone else on the task", async () => {
    // The QA reviewer can SEE the PIC's output — they have to, to review it —
    // but deleting another person's work is a lead decision.
    const attachmentId = await attach(taskId, picId);
    const { client } = await signIn("member2VizBytes");

    await client.from("vizserve_pms_task_attachments").delete().eq("id", attachmentId);

    const { data } = await adminClient()
      .from("vizserve_pms_task_attachments")
      .select("id")
      .eq("id", attachmentId);
    expect(data).toHaveLength(1);
  });

  it.skipIf(!migrationApplied)("can be removed by a department lead", async () => {
    const attachmentId = await attach(taskId, picId);
    const { client } = await signIn("tlVizBytes");

    await client.from("vizserve_pms_task_attachments").delete().eq("id", attachmentId);

    const { data } = await adminClient()
      .from("vizserve_pms_task_attachments")
      .select("id")
      .eq("id", attachmentId);
    expect(data).toEqual([]);
  });

  it.skipIf(!migrationApplied)("cannot be added to a finished task", async () => {
    // Once the client has signed off, the files are the record of what they
    // approved. Adding to them afterwards rewrites that record.
    const { client } = await signIn("tlVizBytes");

    const { data } = await client.rpc("vizserve_pms_create_task", {
      p_department_id: DEPARTMENTS.VizBytes,
      p_title: `P3-13 finished ${Math.random().toString(36).slice(2, 8)}`,
      p_description: "",
      p_assignee_id: picId,
      p_qa_assignee_id: null,
      p_due_date: null,
      p_list_id: null,
    });

    const finished = (data as { task_id: string }).task_id;
    createdTasks.push(finished);

    await client.rpc("vizserve_pms_force_task_status", {
      p_task_id: finished,
      p_to_status: "COMPLETED",
      p_reason: "Fixture — needs to be in a terminal state for this assertion.",
    });

    const { error } = await client.from("vizserve_pms_task_attachments").insert({
      task_id: finished,
      storage_path: `tasks/${finished}/${crypto.randomUUID()}/late.pdf`,
      filename: "late.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
    });

    expect(error).not.toBeNull();
  });
});

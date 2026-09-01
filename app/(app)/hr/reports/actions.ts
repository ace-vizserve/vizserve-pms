"use server";

import { z } from "zod";

import {
  canDoHr,
  requireAuthContextOrThrow,
  type AuthContext,
} from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import {
  groupLeaveReport,
  groupLeaveTaken,
  leaveReportFilename,
  leaveTakenFilename,
  renderLeaveReport,
  renderLeaveTakenReport,
  type LeaveReportRow,
  type LeaveTakenRow,
} from "@/lib/reports/leave-report";
import { leaveReportFilterSchema } from "@/lib/schemas/leave-report";
import { createClient } from "@/utils/supabase/server";

/**
 * P7-53 — the leave audit export. ONE action, three call sites.
 *
 * Called from `/hr/reports` (the builder), from the toolbar on `/admin/users`
 * (which used to carry its own copy) and from `/approvals` ("Download my leave
 * record"). Written once because the thing most worth getting right is the
 * SCOPE LINE printed on the page, and three copies of that logic is three
 * chances for a PDF to misdescribe what it counted.
 *
 * ⚠️ GATED ON A SESSION, NOT ON A ROLE, and that is deliberate. Every caller is
 * allowed to run this; what differs is what comes back. Both RPCs scope
 * themselves — HR and admin get everyone, a lead gets their departments, and
 * since P7-53 anybody gets their own record (amending D30). Putting a role
 * floor here would contradict the SQL and break the member's own-record button.
 *
 * ⚠️ NO CALLER PASSES THE SCOPE STRING. It is derived below from the caller's
 * own context, so no call site can misstate what its document covers.
 */

export type ExportResult =
  | { ok: true; data: { filename: string; base64: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function flattenIssues(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/**
 * What this caller could see, in the words that go on the page.
 *
 * Read from the context rather than from the result, on purpose: describing the
 * scope from the rows that came back would say "Engineering" for an admin whose
 * filter happened to select one department, which is true of the data and false
 * about the authority — and the reader of a signed audit document needs the
 * second one.
 */
async function describeScope(context: AuthContext): Promise<string> {
  if (canDoHr(context)) return "All departments";

  if (context.managedDepartmentIds.length === 0) return "Your own record";

  const supabase = await createClient();
  const { data } = await supabase
    .from("vizserve_pms_departments")
    .select("name")
    .in("id", context.managedDepartmentIds)
    .order("name");

  const names = (data ?? []).map((row) => row.name);
  if (names.length === 0) return "Your own record";

  // "and your own record", because the four-branch authority clause in both
  // functions genuinely returns the lead's own row as well as their teams'.
  // A lead who is not in a department they lead would otherwise find themselves
  // in a report whose header says they should not be.
  return `${names.join(", ")}, and your own record`;
}

/**
 * The filters, as English, for the header block.
 *
 * Names are resolved here rather than passed in, so a caller cannot label a
 * filter with something other than what it filtered by. Empty array means
 * unfiltered, which the PDF renders as no filter lines at all.
 */
async function describeFilters(input: {
  userIds?: string[];
  departmentIds?: string[];
  leaveTypeIds?: string[];
}): Promise<string[]> {
  const lines: string[] = [];
  const supabase = await createClient();

  if (input.userIds?.length) {
    const { data } = await supabase
      .from("vizserve_pms_users")
      .select("full_name")
      .in("id", input.userIds)
      .order("full_name");
    const names = (data ?? []).map((row) => row.full_name);
    lines.push(`Staff: ${names.length > 0 ? names.join(", ") : `${input.userIds.length} selected`}`);
  }

  if (input.departmentIds?.length) {
    const { data } = await supabase
      .from("vizserve_pms_departments")
      .select("name")
      .in("id", input.departmentIds)
      .order("name");
    const names = (data ?? []).map((row) => row.name);
    lines.push(
      `Department: ${names.length > 0 ? names.join(", ") : `${input.departmentIds.length} selected`}`,
    );
  }

  if (input.leaveTypeIds?.length) {
    const { data } = await supabase
      .from("vizserve_pms_leave_types")
      .select("label")
      .in("id", input.leaveTypeIds)
      .order("sort_order");
    const names = (data ?? []).map((row) => row.label);
    lines.push(
      `Leave type: ${names.length > 0 ? names.join(", ") : `${input.leaveTypeIds.length} selected`}`,
    );
  }

  return lines;
}

export async function exportLeaveReport(input: unknown): Promise<ExportResult> {
  const context = await requireAuthContextOrThrow();

  const parsed = leaveReportFilterSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the highlighted fields.",
      fieldErrors: flattenIssues(parsed.error),
    };
  }

  const filter = parsed.data;
  const supabase = await createClient();

  // Resolved once and shared by both branches. `generatedBy` names a person
  // because an audit document with no author cannot be queried later.
  const { data: profile } = await supabase
    .from("vizserve_pms_users")
    .select("full_name, email")
    .eq("id", context.userId)
    .maybeSingle();

  const generatedBy = profile?.full_name || profile?.email || context.email;
  const generatedOn = todayInAppZone();
  const scope = await describeScope(context);
  const filters = await describeFilters(filter);

  if (filter.mode === "annual") {
    const { data, error } = await supabase.rpc("vizserve_pms_leave_report", {
      p_year: filter.year,
      p_user_ids: filter.userIds ?? null,
      p_department_ids: filter.departmentIds ?? null,
      p_leave_type_ids: filter.leaveTypeIds ?? null,
    });

    if (error) return { ok: false, error: error.message };

    const rows = (data ?? []) as LeaveReportRow[];
    if (rows.length === 0) {
      // Not an empty PDF. A blank audit page is indistinguishable from a broken
      // export, and somebody would file it.
      return {
        ok: false,
        error: `Nothing to report for ${filter.year} with these filters.`,
      };
    }

    const bytes = renderLeaveReport(groupLeaveReport(rows), {
      year: filter.year,
      generatedOn,
      generatedBy,
      scope,
      // The YEAR IS NOT A FILTER LINE. It is already the subtitle under the
      // title, and printing it in both places is how the header ended up
      // saying "Calendar year 2026" twice. D30 wants the document to state
      // what it counted; the subtitle does that for the period, and these
      // lines carry only what NARROWS it.
      filters,
    });

    return {
      ok: true,
      data: {
        filename: leaveReportFilename(filter.year),
        base64: Buffer.from(bytes).toString("base64"),
      },
    };
  }

  const { data, error } = await supabase.rpc("vizserve_pms_leave_taken", {
    p_from: filter.from,
    p_to: filter.to,
    p_user_ids: filter.userIds ?? null,
    p_department_ids: filter.departmentIds ?? null,
    p_leave_type_ids: filter.leaveTypeIds ?? null,
  });

  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as LeaveTakenRow[];
  if (rows.length === 0) {
    return {
      ok: false,
      error: "No approved leave was taken in that period with these filters.",
    };
  }

  const bytes = renderLeaveTakenReport(groupLeaveTaken(rows), {
    from: filter.from,
    to: filter.to,
    generatedOn,
    generatedBy,
    scope,
    // Same as Mode A: the period is already the subtitle. See the note there.
    filters,
  });

  return {
    ok: true,
    data: {
      filename: leaveTakenFilename(filter.from, filter.to),
      base64: Buffer.from(bytes).toString("base64"),
    },
  };
}

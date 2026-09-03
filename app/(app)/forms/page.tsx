import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { canAccessDepartment, requireDepartmentShape } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { administersForm } from "./administers";
import { FormsTable, type FormRow } from "./forms-table";

export const metadata: Metadata = { title: "Forms" };

/**
 * P1-05 — forms list.
 *
 * Department-scoped by RLS, so this query needs no `.eq()` on department: a TL
 * who leads VizMedia sees VizMedia's forms and nothing else, and the same query
 * run by an admin returns everything. That is deliberate — the filter lives in
 * one place (the policy) rather than being restated at every call site.
 *
 * ⚠️ P7-66 Phase 4b — WITH ONE EXCEPTION, AND IT IS NOT A RESTATEMENT OF THAT
 * POLICY. `published internal forms readable by their audience`
 * (20260902110000_p7_66_form_responses.sql) lets EVERY active staff member read
 * EVERY published internal form, because a member has to read one to fill it
 * in at /respond. Policies are OR'd, so after it a lead of VizMedia can select
 * VizBytes' published internal forms — and this is the BUILDER, where such a
 * form would be listed as theirs to edit and would open its whole question
 * schema at /forms/[id].
 *
 * No policy can tell the two readers apart: the difference is which QUESTION is
 * being asked, not which rows exist. So the administrative scope is applied
 * here, once, through `administersForm` — the same two clauses
 * `assertCanEditForm` enforces on every write, so a form this list shows is a
 * form this person can actually save.
 *
 * No <h1>. The shell breadcrumb is the page label.
 */
export default async function FormsPage() {
  // P8-01c. Was `requireRole("team_leader")`. A department admin builds their
  // own department's client forms, and may be a MEMBER by rank — the list below
  // is still narrowed per row by `administersForm`, which is what decides whose
  // forms these are.
  const context = await requireDepartmentShape();
  const supabase = await createClient();

  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    // P7-66 — `purpose` for the Type column, `is_public` still for the public
    // URL cell. They cannot disagree (the CHECK sees to that), but they answer
    // different questions: one is what the form IS, the other is whether the
    // /request/ route will serve it.
    // `created_by` is not drawn anywhere — it is read so `administersForm` can
    // recognise an unrouted draft as its author's.
    .select(
      "id, name, slug, purpose, is_public, is_active, reference_prefix, department_id, created_by, created_at, sla_minutes, requires_attachment",
    )
    .order("created_at", { ascending: false });

  const { data: departments } = await supabase.from("vizserve_pms_departments").select("id, name");

  /*
   * P7-66 — HOW MUCH EACH FORM IS ACTUALLY USED.
   *
   * The single most useful fact about a form, and the list never showed it: a
   * published form nobody has submitted to and one carrying half the department
   * s work looked identical.
   *
   * Two ids per row rather than a count per form: PostgREST has no GROUP BY, so
   * the alternative is one `count` query per form. At this row count pulling the
   * ids and tallying them here is one round trip instead of N.
   */
  const { data: submissions } = await supabase
    .from("vizserve_pms_requests")
    .select("form_id, submitted_at");

  const submissionCounts: Record<string, number> = {};
  const lastSubmission: Record<string, string> = {};

  for (const row of submissions ?? []) {
    submissionCounts[row.form_id] = (submissionCounts[row.form_id] ?? 0) + 1;
    // Newest wins. The query has no order, so compare rather than assume.
    if (!lastSubmission[row.form_id] || row.submitted_at > lastSubmission[row.form_id]) {
      lastSubmission[row.form_id] = row.submitted_at;
    }
  }

  /* A Map cannot cross the RSC boundary. */
  const departmentNames = Object.fromEntries((departments ?? []).map((d) => [d.id, d.name]));

  /*
   * Filtered here rather than in the query, because the predicate is a union
   * ("a department I lead" OR "an unrouted draft I wrote") that PostgREST would
   * express as a hand-built `.or()` string — and one that is subtly wrong is a
   * form silently missing from its owner's list. The set is small (a form per
   * request type), this page is capped by nothing else, and `administersForm`
   * is the same rule the write path applies.
   */
  /* Kept before the cast: `FormRow` is the table's shape and omits `created_by`,
     which the author carve-out below needs. */
  const administered = (forms ?? []).filter((form) => administersForm(context, form));
  const rows = administered as FormRow[];

  /*
   * ⚠️ WHOSE SUBMISSIONS THIS VIEWER CAN ACTUALLY READ — see the column comment
   * in `forms-table.tsx`.
   *
   * `canAccessDepartment`, the mirror of `vizserve_pms_manages_department`,
   * because that is the policy on `vizserve_pms_requests` and the P8-01c tick
   * does not widen it. Deriving this from the counts instead ("zero must mean
   * refused") is the trap: a genuinely unused form and an unreadable one are
   * both zero, and the two must not print the same word.
   */
  const submissionsReadable: Record<string, boolean> = Object.fromEntries(
    administered.map((form) => [
      form.id,
      /* ⚠️ AN UNROUTED DRAFT IS READABLE BECAUSE ITS COUNT IS PROVABLY ZERO.
         `canAccessDepartment(ctx, null)` is false for anyone below owner, so
         without this a team leader's own draft printed "Not shown" — claiming a
         permission problem where none exists, which is the exact confusion this
         flag was added to prevent, just inverted. A form with no department
         cannot be published (`vizserve_pms_forms_active_requires_department`),
         so nobody can have submitted to it and "None" is the true answer.
         `administersForm`'s author carve-out is what put the row here at all. */
      form.department_id === null
        ? form.created_by === context.userId
        : canAccessDepartment(context, form.department_id),
    ]),
  );

  return (
    <PageShell>
      <div className="flex items-center justify-end">
        <Link href="/forms/new" className={buttonVariants({ size: "sm" })}>
          <Plus />
          New form
        </Link>
      </div>

      <FormsTable
        rows={rows}
        departmentNames={departmentNames}
        submissionCounts={submissionCounts}
        submissionsReadable={submissionsReadable}
        lastSubmission={lastSubmission}
      />
    </PageShell>
  );
}

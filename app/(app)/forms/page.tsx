import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/authorization";
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
  const context = await requireRole("team_leader");
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
      "id, name, slug, purpose, is_public, is_active, reference_prefix, department_id, created_by, created_at",
    )
    .order("created_at", { ascending: false });

  const { data: departments } = await supabase.from("vizserve_pms_departments").select("id, name");

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
  const rows = (forms ?? []).filter((form) => administersForm(context, form)) as FormRow[];

  return (
    <PageShell>
      <div className="flex items-center justify-end">
        <Link href="/forms/new" className={buttonVariants({ size: "sm" })}>
          <Plus />
          New form
        </Link>
      </div>

      <FormsTable rows={rows} departmentNames={departmentNames} />
    </PageShell>
  );
}

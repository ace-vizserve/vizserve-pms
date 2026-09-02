import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
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
 * No <h1>. The shell breadcrumb is the page label.
 */
export default async function FormsPage() {
  await requireRole("team_leader");
  const supabase = await createClient();

  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    // P7-66 — `purpose` for the Type column, `is_public` still for the public
    // URL cell. They cannot disagree (the CHECK sees to that), but they answer
    // different questions: one is what the form IS, the other is whether the
    // /request/ route will serve it.
    .select(
      "id, name, slug, purpose, is_public, is_active, reference_prefix, department_id, created_at",
    )
    .order("created_at", { ascending: false });

  const { data: departments } = await supabase.from("vizserve_pms_departments").select("id, name");

  /* A Map cannot cross the RSC boundary. */
  const departmentNames = Object.fromEntries((departments ?? []).map((d) => [d.id, d.name]));
  const rows = (forms ?? []) as FormRow[];

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

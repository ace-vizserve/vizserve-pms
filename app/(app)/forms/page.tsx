import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Forms" };

/**
 * P1-05 — forms list.
 *
 * Department-scoped by RLS, so this query needs no `.eq()` on department: a TL
 * who leads VizMedia sees VizMedia's forms and nothing else, and the same query
 * run by an admin returns everything. That is deliberate — the filter lives in
 * one place (the policy) rather than being restated at every call site.
 */
export default async function FormsPage() {
  await requireRole("team_leader");
  const supabase = await createClient();

  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, slug, is_public, is_active, reference_prefix, department_id, updated_at")
    .order("updated_at", { ascending: false });

  const { data: departments } = await supabase
    .from("vizserve_pms_departments")
    .select("id, name");

  const departmentName = new Map((departments ?? []).map((d) => [d.id, d.name]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Forms</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Client-facing request forms. Publishing one gives it a public URL that needs no login.
          </p>
        </div>
        <Button size="sm" render={<Link href="/forms/new" />}>
            <Plus />
            New form
          </Button>
      </div>

      {!forms || forms.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No forms yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            A form defines what a client must tell you before the team will accept the work. Every
            required field is a question you will never have to chase.
          </p>
          <Button size="sm" className="mt-4" render={<Link href="/forms/new" />}>Create the first form</Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Form</th>
                <th className="px-4 py-2.5 text-left font-medium">Department</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Public URL</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((form) => (
                <tr key={form.id} className="border-t">
                  <td className="px-4 py-3">
                    <Link href={`/forms/${form.id}`} className="font-medium hover:underline">
                      {form.name}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {form.reference_prefix}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {form.department_id ? (
                      departmentName.get(form.department_id)
                    ) : (
                      <span className="text-warning">Not routed</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {/* Status is never colour alone — the label carries it. */}
                    {form.is_active ? (
                      <span className="rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success">
                        Live
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                        Draft
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {form.is_active && form.is_public ? (
                      <Link
                        href={`/f/${form.slug}`}
                        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        /f/{form.slug}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireRole, roleAtLeast } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { FormSettings } from "../form-settings";

export const metadata: Metadata = { title: "New form" };

export default async function NewFormPage() {
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  // Only offer departments this person can actually route to. An admin routes
  // anywhere; everyone else is limited to what they lead, so the selector
  // cannot be used to hand work to a queue they do not own.
  const query = supabase.from("vizserve_pms_departments").select("id, name").eq("is_active", true);
  if (!roleAtLeast(context.role, "admin")) {
    query.in("id", context.managedDepartmentIds.length > 0 ? context.managedDepartmentIds : [""]);
  }
  const { data: departments } = await query.order("name");

  // P2-06 — a brand-new form can point at an existing list straight away.
  const { data: lists } = await supabase
    .from("vizserve_pms_lists")
    .select("id, name, department_id")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");

  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      <div>
        <Link
          href="/forms"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Forms
        </Link>
        {/* No <h1> — the breadcrumb reads "Forms / New". This line survives
            because it says what happens next, which the crumb cannot. */}
        <p className="mt-2 text-xs text-muted-foreground">
          Set it up here, then add the fields. It stays a draft until you publish it.
        </p>
      </div>

      <div className="rounded-lg border bg-card grade-surface p-6 shadow-raised-lg">
        <FormSettings departments={departments ?? []} lists={lists ?? []} />
      </div>
    </PageShell>
  );
}

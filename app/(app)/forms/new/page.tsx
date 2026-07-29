import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireRole, roleAtLeast } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/forms"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Forms
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">New form</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Set it up here, then add the fields. It stays a draft until you publish it.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-ring">
        <FormSettings departments={departments ?? []} />
      </div>
    </div>
  );
}

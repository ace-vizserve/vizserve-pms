import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { FormSettings } from "../form-settings";
import { loadRoutableDepartments } from "../routable-departments";

export const metadata: Metadata = { title: "New form" };

export default async function NewFormPage() {
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  /*
   * Only offer departments this person can actually route to.
   *
   * ⚠️ THE ERROR IS STILL NOT SURFACED HERE, and that is now a decision rather
   * than an oversight. This page has nothing to lose: it renders a blank
   * settings card for a form that does not exist yet, and a save with no
   * department selected is refused by the form's own schema, not by what this
   * list happened to contain. /forms/[id] is the one where an empty list can be
   * written back over a real form, and it treats the error accordingly.
   *
   * What DID change is the "leads nothing" case: it no longer sends
   * `.in("id", [""])`, which always failed with `invalid input syntax for type
   * uuid: ""` and left this page silently querying nothing at all.
   */
  const { departments } = await loadRoutableDepartments(supabase, context);

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
        <FormSettings departments={departments} lists={lists ?? []} />
      </div>
    </PageShell>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { publicFormSchema } from "@/lib/schemas/forms";
import { PublicFormRenderer } from "./public-form";

/**
 * P1-06 — the public form. NO SESSION, by design (Amier, 50:30).
 *
 * The page reads the form through a SECURITY DEFINER function rather than a
 * table, so `anon` has no table access at all and the shape returned is only
 * what a renderer needs — never the owning department, the SLA, or who built it.
 */

async function loadForm(slug: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_get_public_form", { p_slug: slug });

  if (error || !data) return null;

  const parsed = publicFormSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const form = await loadForm((await params).slug);
  return { title: form?.name ?? "Form" };
}

export default async function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const form = await loadForm((await params).slug);

  if (!form) notFound();

  return (
    <main className="min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
            V
          </span>
          <span className="text-sm font-semibold tracking-tight">VizServe</span>
        </div>

        <div className="rounded-xl border bg-card p-6 sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{form.name}</h1>
          {form.description ? (
            <p className="mt-2 text-sm text-muted-foreground">{form.description}</p>
          ) : null}

          {/* The completeness rule, said out loud. A client who is told why the
              form is strict argues with it less than one who is only told they
              got something wrong. */}
          <p className="mt-4 rounded-sm bg-info-subtle px-3 py-2 text-xs text-info">
            Every required field must be filled before we can accept the request. This is what lets
            us start work immediately instead of coming back with questions.
          </p>

          <div className="mt-6">
            <PublicFormRenderer form={form} />
          </div>
        </div>
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Info } from "lucide-react";

import { createClient } from "@/utils/supabase/server";
import { publicFormSchema } from "@/lib/schemas/forms";
import { PublicFormRenderer } from "./public-form";
import { BrandLockup } from "@/components/brand-lockup";

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
    // py-10 flat, matching /approve and /feedback. The sm:py-14 I had put here
    // was adding to an already-airy logo block.
    <main className="client-surface min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5">
          <BrandLockup align="stacked" subtitle="Request form" />
        </div>

        <div className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
          {/* A titled header band rather than a heading floating above the
              fields. On a page a client sees once, the boundary between "what
              this is" and "what you have to do" is worth drawing. */}
          <div className="border-b bg-muted/30 px-6 py-5 sm:px-8">
            <h1 className="text-xl font-semibold tracking-tight text-balance">{form.name}</h1>
            {form.description ? (
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{form.description}</p>
            ) : null}
          </div>

          <div className="px-6 py-6 sm:px-8 sm:py-8">
            {/* The completeness rule, said out loud. A client who is told why
                the form is strict argues with it less than one who is only told
                afterwards that they got something wrong. */}
            <div className="mb-6 flex gap-2.5 rounded-lg bg-info-subtle px-3.5 py-3 text-xs text-info">
              <Info aria-hidden className="mt-px size-4 shrink-0" />
              <p className="text-pretty">
                Every required field must be filled before we can accept the request. This is what
                lets us start work immediately instead of coming back with questions.
              </p>
            </div>

            <PublicFormRenderer form={form} />
          </div>
        </div>

        {/* Public page, no session — so it says who it belongs to. Without
            this the page is an unbranded form asking for an email address,
            which is what a phishing page looks like. */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Submitted to VizServe. You will get a reference number and an email when the work is ready
          for your approval.
        </p>
      </div>
    </main>
  );
}

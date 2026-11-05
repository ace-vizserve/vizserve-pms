import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BrandLockup } from "@/components/brand-lockup";
import { formatDate } from "@/lib/dates";
import { splitCanvasFields } from "@/lib/form-builder/canvas";
import { isFormClosed } from "@/lib/form-builder/deadline";
import { FormSchemaError, parseFormSchema } from "@/lib/form-builder/schema";
import { createAdminClient } from "@/utils/supabase/admin";

import { SurveyForm } from "./survey-form";

/**
 * P17-15 — A SURVEY OR QUIZ FOR ANYONE WITH THE LINK. No session, by design.
 *
 * The service role, for the reason /request has a SECURITY DEFINER lookup: `anon`
 * holds no table privileges. Only what the page draws is selected. The blob carries
 * no answer key (`correct_answer` lives on the field rows), so a quiz is safe to serve.
 */
async function loadSurvey(slug: string) {
  const { data } = await createAdminClient()
    .from("vizserve_pms_forms")
    .select("id, name, slug, description, schema, is_anonymous, closes_on")
    .eq("slug", slug)
    .eq("purpose", "INTERNAL")
    .eq("accepts_external", true)
    .eq("is_active", true)
    .is("archived_at", null)
    .maybeSingle();
  return data;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const form = await loadSurvey((await params).slug);
  return { title: form?.name ?? "Survey" };
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-6 text-center">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

export default async function PublicSurveyPage({ params }: { params: Promise<{ slug: string }> }) {
  const form = await loadSurvey((await params).slug);

  if (!form) notFound();

  let schema;

  try {
    schema = await parseFormSchema(form.schema);
  } catch (cause) {
    if (!(cause instanceof FormSchemaError)) throw cause;
    console.error("[P17-15] a public survey did not parse", { slug: form.slug, reason: cause.reason.code });
    schema = null;
  }

  const closed = isFormClosed(form.closes_on);

  return (
    <main className="client-surface min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5">
          <BrandLockup align="stacked" subtitle="Survey" />
        </div>

        <div className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
          <div className="border-b bg-muted/30 px-6 py-5 sm:px-8">
            <h1 className="text-xl font-semibold tracking-tight text-balance">{form.name}</h1>
            {form.description ? (
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{form.description}</p>
            ) : null}
            {form.closes_on && !closed ? (
              <p className="mt-1.5 text-sm font-medium">Please answer by {formatDate(form.closes_on)}.</p>
            ) : null}
            {/* Said before they answer, both ways, as on /respond. */}
            <p className="mt-1.5 text-xs text-muted-foreground">
              {form.is_anonymous
                ? "Your name is not asked for or recorded with this answer."
                : "Your name and email are saved with your answer and can be read by the team that runs this form."}
            </p>
          </div>

          <div className="px-6 py-6 sm:px-8 sm:py-8">
            {schema === null ? (
              <Message title="This form could not be opened" body="Tell whoever sent you the link." />
            ) : closed ? (
              <Message title="This form has closed" body={`It stopped taking answers after ${formatDate(form.closes_on)}.`} />
            ) : splitCanvasFields(schema).active.length === 0 ? (
              <Message title="This form has no questions yet" body="Tell whoever sent you the link." />
            ) : (
              <SurveyForm
                formId={form.id}
                formSlug={form.slug}
                formName={form.name}
                isAnonymous={form.is_anonymous}
                schema={schema}
              />
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">Submitted to VizServe.</p>
      </div>
    </main>
  );
}

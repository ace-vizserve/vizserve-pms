import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FilePenLine } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import { requireAuthContext } from "@/lib/auth/authorization";
import { FormSchemaError, parseFormSchema } from "@/lib/form-builder/schema";
import { createClient } from "@/utils/supabase/server";

import { RespondForm } from "./respond-form";

export const metadata: Metadata = { title: "Fill a form" };

/**
 * P7-66 Phase 4b — ANSWERING ONE ENGAGEMENT FORM.
 *
 * ⚠️ THE SCHEMA IS READ FROM `vizserve_pms_forms.schema`, NOT FROM
 * `vizserve_pms_form_fields`, and that is a decision rather than a shortcut.
 *
 * The builder at /forms/[id] reconciles the blob against the rows and lets the
 * ROWS win, because Phase 1's dual-write could leave a stale blob behind on a
 * form that was published and then left alone. No engagement form can be in
 * that state: `purpose` shipped after Phase 2, so every engagement form there
 * will ever be was written by `vizserve_pms_save_form_schema`, which stores the
 * blob AND projects the rows in ONE transaction. The blob is therefore current
 * by construction here.
 *
 * The security half matters more. Reading the rows would mean widening the
 * `form fields follow their form` policy — which is department-scoped — to
 * every member in the company. Reading the blob needs only the one narrow
 * policy this phase adds (`published engagement forms readable by staff`), so a
 * member gains sight of published engagement forms and of nothing else.
 *
 * ⚠️ NO `SECURITY DEFINER` LOOKUP either, unlike /request/[slug]. That function
 * exists because `anon` holds no table privileges at all. This caller has a
 * session and ordinary RLS answers the question.
 */
export default async function RespondToFormPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  await requireAuthContext();
  const supabase = await createClient();

  const { data: form, error } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, slug, description, schema")
    // Not a restatement of a department policy (CLAUDE.md) — these two say
    // WHICH FORMS THIS ROUTE SERVES. A team leader can read their own client
    // forms through the P1 policies, and a client form answered here would put
    // a request's worth of answers in the wrong table with no reference number.
    // `submitFormResponse` re-checks both, and so does the INSERT policy.
    .eq("slug", slug)
    .eq("purpose", "EMPLOYEE_ENGAGEMENT")
    .eq("is_active", true)
    .maybeSingle();

  // "The query died" and "no such form" are different sentences, and only one
  // of them is worth reporting to support.
  if (error) {
    return (
      <PageShell className="max-w-3xl">
        <QueryError what="this form" message={error.message} />
      </PageShell>
    );
  }

  // A draft, a client form, or nothing at all — all 404, which tells a caller
  // guessing slugs nothing about which of the three it was.
  if (!form) notFound();

  let schema;

  try {
    schema = await parseFormSchema(form.schema);
  } catch (cause) {
    if (!(cause instanceof FormSchemaError)) throw cause;

    // The reason CODE, never the payload — it can carry a raw thrown value.
    console.error("[P7-66] a published engagement form did not parse", {
      slug,
      reason: cause.reason.code,
    });

    return (
      <PageShell className="max-w-3xl">
        <QueryError
          what="this form"
          message="Its questions could not be read. Tell whoever set it up."
        />
      </PageShell>
    );
  }

  return (
    // A reading measure, unlike the list pages: this is a form to fill in top
    // to bottom, and a question that runs the width of an ultrawide monitor is
    // harder to answer, not easier. `cn` is tailwind-merge, so this replaces
    // PageShell's own width rather than fighting it.
    <PageShell className="max-w-3xl">
      <div className="flex items-start gap-3">
        <Link href="/respond" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <ArrowLeft />
          All forms
        </Link>
      </div>

      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-[-0.022em]">{form.name}</h1>
        {form.description ? (
          <p className="text-sm leading-relaxed text-foreground-muted">{form.description}</p>
        ) : null}
        {/*
          ⚠️ SAID BEFORE THEY ANSWER, NOT AFTER.

          `vizserve_pms_form_responses.submitted_by` is not null and the SELECT
          policy shows that name beside the answers. A pulse survey people
          believe is anonymous, stored in a table that names them, is a broken
          promise — so the page says what is true, in the person's sight, while
          they can still decide what to write. See the ANONYMITY block in
          20260902110000_p7_66_form_responses.sql.
        */}
        <p className="text-xs text-muted-foreground">
          Your answer is saved against your name and can be read by the team that owns this form.
          This form is not anonymous.
        </p>
      </div>

      {schema.root.length === 0 ? (
        <EmptyState
          icon={<FilePenLine />}
          title="This form has no questions yet"
          description="It has been published before any questions were added. Tell whoever set it up — there is nothing to answer until they do."
        />
      ) : (
        <RespondForm
          formId={form.id}
          formSlug={form.slug}
          formName={form.name}
          schema={schema}
        />
      )}
    </PageShell>
  );
}

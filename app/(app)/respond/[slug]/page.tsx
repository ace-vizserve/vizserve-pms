import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FilePenLine } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import { requireAuthContext } from "@/lib/auth/authorization";
import { splitCanvasFields } from "@/lib/form-builder/canvas";
import { FormSchemaError, parseFormSchema } from "@/lib/form-builder/schema";
import { createClient } from "@/utils/supabase/server";

import { RespondForm } from "./respond-form";

export const metadata: Metadata = { title: "Fill a form" };

/**
 * P7-66 Phase 4b — ANSWERING ONE INTERNAL FORM.
 *
 * ⚠️ THE SCHEMA IS READ FROM `vizserve_pms_forms.schema`, NOT FROM
 * `vizserve_pms_form_fields`, and that is a decision rather than a shortcut.
 *
 * The builder at /forms/[id] reconciles the blob against the rows and lets the
 * ROWS win, because Phase 1's dual-write could leave a stale blob behind on a
 * form that was published and then left alone. No internal form can be in
 * that state: `purpose` shipped after Phase 2, so every internal form there
 * will ever be was written by `vizserve_pms_save_form_schema`, which stores the
 * blob AND projects the rows in ONE transaction. The blob is therefore current
 * by construction here.
 *
 * The security half matters more. Reading the rows would mean widening the
 * `form fields follow their form` policy — which is department-scoped — to
 * every member in the company. Reading the blob needs only the one narrow
 * policy this phase adds (`published internal forms readable by their audience`), so a
 * member gains sight of published internal forms and of nothing else.
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
    .select("id, name, slug, description, schema, is_anonymous")
    // Not a restatement of a department policy (CLAUDE.md) — these two say
    // WHICH FORMS THIS ROUTE SERVES. A team leader can read their own client
    // forms through the P1 policies, and a client form answered here would put
    // a request's worth of answers in the wrong table with no reference number.
    // `submitFormResponse` re-checks both, and so does the INSERT policy.
    .eq("slug", slug)
    .eq("purpose", "INTERNAL")
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
    console.error("[P7-66] a published internal form did not parse", {
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

  /*
   * The questions this form actually asks. `splitCanvasFields` is the builder's
   * own reader of the same distinction, used here rather than restated so the
   * two cannot disagree about what "archived" means.
   */
  const activeQuestionCount = splitCanvasFields(schema).active.length;

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
          ⚠️ SAID BEFORE THEY ANSWER, NOT AFTER — AND SAID BOTH WAYS.

          A pulse survey people BELIEVE is anonymous, stored in a table that
          names them, is a broken promise. But the silence is only half the
          problem: a form that IS anonymous and does not say so collects the
          guarded, careful answers of somebody who assumed the worst, which is
          the failure the setting exists to prevent. Neither sentence is the
          safe default, so the page states whichever one is true.

          ⚠️ FROM `form.is_anonymous`, WHICH IS THE FORM'S PROPERTY. The
          sentence and what `submitFormResponse` writes read the SAME column on
          the SAME row.

          ⚠️ BUT NOT AT THE SAME MOMENT, AND THE GAP IS REAL.
          20260902105000_p7_66_form_anonymity.sql locks the flag on the FIRST
          answer — so on a form that has none yet it can still legitimately move
          between this render and that insert, and somebody who read the
          sentence above would have their name written under it. The page
          therefore sends this value back with the answer and the action REFUSES
          if the form no longer agrees; see `promised_anonymous`. See also the
          ANONYMITY block in 20260902110000_p7_66_form_responses.sql.
        */}
        {form.is_anonymous ? (
          <p className="text-xs text-muted-foreground">
            {/* "Not recorded", not "not shown". The distinction is the whole
                feature: nothing is written, so there is no name to be revealed
                later by an export, a new screen or an admin with SQL. */}
            Your name is <strong className="font-medium">not recorded</strong> with this answer. The
            team that owns this form sees what you wrote and when, and nothing that identifies you.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Your answer is saved against your name and can be read by the team that owns this form.
            This form is not anonymous.
          </p>
        )}
      </div>

      {/*
        ⚠️ COUNTED WITHOUT THE ARCHIVED ONES, and `root.length` is not that
        number. `root` keeps every field a form has EVER had — that is what
        `archivedAttribute` is for, so historical answers keep something to be
        filed under — so a form whose questions have all been archived has a
        non-empty `root` and no questions.

        Read as `root.length` it skipped this branch and rendered `RespondForm`,
        which drew nothing at all (the library skips an unprocessable entity)
        under a live Send answer button: one press, and a
        `vizserve_pms_form_responses` row with `field_values: {}` that nobody
        can delete, because the table is append-only by design.
      */}
      {activeQuestionCount === 0 ? (
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
          isAnonymous={form.is_anonymous}
          schema={schema}
        />
      )}
    </PageShell>
  );
}

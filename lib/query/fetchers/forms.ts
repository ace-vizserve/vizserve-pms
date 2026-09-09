import { parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  formListRowSchema,
  formSubmissionTallySchema,
  type FormListRow,
} from "@/lib/schemas/forms";

import type { TaskReadClient } from "./task";

/**
 * P12-22 — the reads behind `/forms`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. `page.tsx` was an RSC awaiting three queries — the forms,
 * the department names and every submission in scope — and handing the whole
 * table down as props. Every write anywhere in the builder ran
 * `revalidatePath("/forms")`, so renaming a form re-read all three and
 * re-rendered the shell above them.
 *
 * ⚠️ THE DEPARTMENTS DID NOT COME ALONG. They are reference data and live at
 * `qk.ref("departments")`, where five other screens already hold them — see
 * `lib/query/fetchers/ref.ts`. That is one of the three round trips deleted
 * outright rather than moved.
 *
 * ⚠️ THE ADMINISTRATIVE FILTER IS NOT IN THIS FILE AND MUST NOT MOVE INTO IT.
 * `administersForm` decides which of the readable forms are this person's to
 * EDIT, and it is applied in `forms-view.tsx` over the rows this returns. It
 * cannot be a `.or()` in the query below: the predicate is a union ("a
 * department I lead" OR "an unrouted draft I wrote" OR "an internal form and I
 * am an owner") and a hand-built PostgREST `or=` string that is subtly wrong is
 * a form silently missing from its owner's list. The set is small — a form per
 * request type — and `administersForm` is the same rule the write path applies,
 * so a form this list shows is a form this person can actually save.
 *
 * ⚠️ AND NEITHER QUERY CARRIES A DEPARTMENT FILTER. Both are RLS-scoped; the
 * filter above is about which QUESTION is being asked, not about which rows
 * exist, which is exactly why no policy can express it (`administers.ts` argues
 * this at length). Adding a scope filter here would imply the policy were
 * optional.
 *
 * ⚠️ BOTH READS THROW. `page.tsx` did `forms ?? []` and `submissions ?? []` and
 * never looked at either error — so a failed forms read rendered the empty state
 * on a screen whose empty state invites you to build the first form, and a
 * failed submissions read printed "None" beside every form in the company.
 * ------------------------------------------------------------------------
 */

export type FormsList = {
  forms: FormListRow[];
  /** Form id → how many submissions it has taken. */
  submissionCounts: Record<string, number>;
  /** Form id → the newest submission's timestamp. */
  lastSubmission: Record<string, string>;
};

/**
 * `qk.forms()` — every form this person can read, with its usage.
 *
 * Two reads in ONE wave. Neither takes an argument from the other: the forms and
 * the submission tally are two independent facts, so the RSC was paying two
 * round trips for one wave's worth of dependency and this keeps its fix.
 */
export async function fetchForms(client: TaskReadClient): Promise<FormsList> {
  const [formRows, submissionRows] = await Promise.all([
    read<unknown[]>(
      client
        .from("vizserve_pms_forms")
        .select(
          "id, name, slug, purpose, is_public, is_active, reference_prefix, department_id, created_by, created_at, sla_minutes, requires_attachment",
        )
        .order("created_at", { ascending: false }),
    ),

    /*
     * P7-66 — HOW MUCH EACH FORM IS ACTUALLY USED.
     *
     * The single most useful fact about a form, and the list never showed it: a
     * published form nobody has submitted to and one carrying half the
     * department's work looked identical.
     */
    read<unknown[]>(client.from("vizserve_pms_requests").select("form_id, submitted_at")),
  ]);

  const submissionCounts: Record<string, number> = {};
  const lastSubmission: Record<string, string> = {};

  for (const row of parseAll(formSubmissionTallySchema, submissionRows, "submissions")) {
    submissionCounts[row.form_id] = (submissionCounts[row.form_id] ?? 0) + 1;
    // Newest wins. The query has no order, so compare rather than assume.
    if (!lastSubmission[row.form_id] || row.submitted_at > lastSubmission[row.form_id]!) {
      lastSubmission[row.form_id] = row.submitted_at;
    }
  }

  return {
    forms: parseAll(formListRowSchema, formRows, "forms"),
    submissionCounts,
    lastSubmission,
  };
}

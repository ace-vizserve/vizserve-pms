"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { TableSkeleton } from "@/components/skeletons";
import { buttonVariants } from "@/components/ui/button";
import { canAccessDepartmentScope } from "@/lib/auth/roles";
import { browserClient } from "@/lib/query/browser-client";
import { fetchForms, type FormsList } from "@/lib/query/fetchers/forms";
import { fetchDepartments } from "@/lib/query/fetchers/ref";
import { qk } from "@/lib/query/keys";

import { administersForm, type FormAdminScope } from "./administers";
import { FormsTable, type FormRow } from "./forms-table";

/**
 * P1-05 / P12-22 — the forms list, reading from the cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * `page.tsx` was an RSC holding three queries and every derivation below.
 * Because the builder's five writes all call `revalidatePath("/forms")`,
 * renaming one form re-read every form in the company, every submission in
 * scope and the department list, and re-rendered the shell above them. It is now
 * two keys — `qk.forms()` and `qk.ref("departments")`, the second of which five
 * other screens have already populated.
 *
 * ⚠️ THE SEAT IS STILL RESOLVED ON THE SERVER AND ARRIVES AS A PROP.
 * `requireDepartmentShape()` runs in `page.tsx`; `viewer` is the five fields of
 * that context this file's two rules read, and nothing here asks the browser who
 * it is. Settled decision 6 — authentication does not move in any phase.
 *
 * ⚠️ AND `administersForm` HAD TO FOLLOW THE ROWS. It is the rule that decides
 * which readable forms are this person's to EDIT, and it cannot run before the
 * rows arrive. P12-22 moved the two predicates it needs into `lib/auth/roles.ts`
 * so it could — see the note on `FormAdminScope`. It is PRESENTATION: every
 * write re-checks it through `assertCanEditForm` and then through `forms
 * updatable in scope`, which never widened.
 * ------------------------------------------------------------------------
 */
export function FormsView({ viewer }: { viewer: FormAdminScope }) {
  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still rendered on the server for its initial
   * HTML and `createBrowserClient` reaches for `document.cookie`, which does not
   * exist there. A `queryFn` only ever runs in the browser.
   */
  const formsQuery = useQuery({
    queryKey: qk.forms(),
    queryFn: () => fetchForms(browserClient()),
  });

  /*
   * The department NAMES. Reference data, so `qk.ref("departments")` rather
   * than a third read on this page's own key — arriving from `/tasks` or
   * `/reports` this costs nothing at all.
   *
   * ⚠️ AND IT HOLDS RETIRED DEPARTMENTS SINCE P12-20, which matters here: a form
   * routed to a department that has since been folded into another one still has
   * to say which one, or the Department column reads as unrouted on a form that
   * very much is not.
   */
  const departmentsQuery = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchDepartments(browserClient()),
  });

  const failure = formsQuery.error ?? departmentsQuery.error;

  return (
    <PageShell>
      <div className="flex items-center justify-end">
        {/*
          ⚠️ ABOVE THE QUERY STATES, DELIBERATELY. "Build the first form" is the
          empty state's own invitation, and a failed read must not take the way
          out with it — somebody who cannot see their forms should still be able
          to reach the one screen that does not depend on this query.
        */}
        <Link href="/forms/new" className={buttonVariants({ size: "sm" })}>
          <Plus />
          New form
        </Link>
      </div>

      {failure ? (
        /*
         * ⚠️ THE EMPTY STATE ON THIS SCREEN INVITES YOU TO CREATE A FORM, which
         * is what makes the P12-01 bug expensive here rather than merely wrong.
         * `page.tsx` wrote `forms ?? []` and never read the error, so a dropped
         * read rendered "Nothing here yet — build your first form" to somebody
         * who has six. Acting on that makes a duplicate of a form they already
         * had, with a slug the unique index then refuses.
         */
        <QueryError what="your forms" message={failure.message} />
      ) : !formsQuery.data || !departmentsQuery.data ? (
        <TableSkeleton columns={6} rows={5} />
      ) : (
        <Table
          viewer={viewer}
          forms={formsQuery.data}
          departments={departmentsQuery.data}
        />
      )}
    </PageShell>
  );
}

/**
 * The two per-row rules, and the table.
 *
 * Split from the query component so the derivations read as one block rather
 * than as the tail of a ternary. Nothing is fetched here.
 */
function Table({
  viewer,
  forms,
  departments,
}: {
  viewer: FormAdminScope;
  forms: FormsList;
  departments: { id: string; name: string }[];
}) {
  /*
   * ⚠️ P7-66 Phase 4b — THE ADMINISTRATIVE SCOPE, APPLIED ONCE, HERE.
   *
   * `published internal forms readable by their audience`
   * (20260902110000_p7_66_form_responses.sql) lets EVERY active staff member
   * read EVERY published internal form, because a member has to read one to fill
   * it in at /respond. Policies are OR'd, so after it a lead of VizMedia can
   * select VizBytes' published internal forms — and this is the BUILDER's list,
   * where such a form would be offered as theirs to edit and would open its
   * whole question schema at /forms/[id].
   *
   * No policy can tell the two readers apart: the difference is which QUESTION
   * is being asked, not which rows exist. So the scope is applied here, once,
   * through `administersForm` — the same two clauses `assertCanEditForm`
   * enforces on every write, so a form this list shows is a form this person can
   * actually save.
   */
  const administered = forms.forms.filter((form) => administersForm(viewer, form));

  /*
   * ⚠️ WHOSE SUBMISSIONS THIS VIEWER CAN ACTUALLY READ — see the column comment
   * in `forms-table.tsx`.
   *
   * `canAccessDepartmentScope`, the mirror of `vizserve_pms_manages_department`,
   * because that is the policy on `vizserve_pms_requests` and the P8-01c tick
   * does not widen it. Deriving this from the counts instead ("zero must mean
   * refused") is the trap: a genuinely unused form and an unreadable one are
   * both zero, and the two must not print the same word.
   */
  const submissionsReadable: Record<string, boolean> = Object.fromEntries(
    administered.map((form) => [
      form.id,
      /* ⚠️ AN UNROUTED DRAFT IS READABLE BECAUSE ITS COUNT IS PROVABLY ZERO.
         `canAccessDepartmentScope(viewer, null)` is false for anyone below
         owner, so without this a team leader's own draft printed "Not shown" —
         claiming a permission problem where none exists, which is the exact
         confusion this flag was added to prevent, just inverted. A form with no
         department cannot be published
         (`vizserve_pms_forms_active_requires_department`), so nobody can have
         submitted to it and "None" is the true answer. `administersForm`'s
         author carve-out is what put the row here at all. */
      form.department_id === null
        ? form.created_by === viewer.userId
        : canAccessDepartmentScope(viewer, form.department_id),
    ]),
  );

  return (
    <FormsTable
      /* `FormRow` is the table's shape and omits `created_by`, which the author
         carve-out above needed. Narrowed after the filter, not before it. */
      rows={administered as FormRow[]}
      departmentNames={Object.fromEntries(departments.map((row) => [row.id, row.name]))}
      submissionCounts={forms.submissionCounts}
      submissionsReadable={submissionsReadable}
      lastSubmission={forms.lastSubmission}
    />
  );
}

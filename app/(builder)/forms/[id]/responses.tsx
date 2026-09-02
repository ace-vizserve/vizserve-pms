import { PAGE_SIZES, Pagination } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import type { Json } from "@/lib/database.types";
import type { FormSchema } from "@/lib/form-builder/builder";
import { answeredKeysOf, responseColumns } from "@/lib/form-builder/responses";
import { createClient } from "@/utils/supabase/server";

import { ResponsesTable, type ResponseRow } from "./responses-table";

/**
 * P7-66 Phase 4b — the Responses section of the builder page.
 *
 * Ace's ask, verbatim: "an internal form if youre an admin you can just gonna
 * click the form and have the view of submissions basically like google forms."
 * So it lives on the form, under the questions, rather than behind a second
 * route somebody has to know about.
 *
 * ⚠️ ENGAGEMENT FORMS ONLY, and the caller decides that. A CLIENT_REQUEST
 * form's submissions are `vizserve_pms_requests` and are already read at
 * /requests — with a reference number, a status, a Gate 1 decision and an SLA
 * clock, none of which this table has anywhere to put. Two screens for one
 * thing is the redundancy CLAUDE.md warns about; this is the other thing.
 *
 * A server component: it owns the query and the paging, and hands
 * `ResponsesTable` plain serialisable rows, because `DataTable` is a client
 * component and a `cell` closure cannot cross the boundary.
 */
export async function FormResponses({
  formId,
  departmentId,
  schema,
  page,
  pageSize,
}: {
  formId: string;
  /** Null on an unrouted draft — see the note below. */
  departmentId: string | null;
  /**
   * The form as the builder opened it — reconciled against the field rows, so
   * ARCHIVED FIELDS ARE PRESENT. That is what lets a column exist for a
   * question the form has stopped asking but whose answers are still stored.
   */
  schema: FormSchema;
  page: number;
  pageSize: number;
}) {
  const supabase = await createClient();
  const from = (page - 1) * pageSize;

  /*
   * No `.eq()` on anything but the form. `form responses readable by the
   * owning department` scopes the rows to an admin or the lead of the
   * department that owns this form — restating that here would imply the policy
   * is optional (CLAUDE.md).
   *
   * `submitted_at desc` is the order and the only order: newest first is what
   * makes a re-submission readable, since somebody who answered wrongly answers
   * again and both rows stand (there is no edit and no delete).
   */
  const { data, count, error } = await supabase
    .from("vizserve_pms_form_responses")
    .select("id, submitted_by, field_values, submitted_at", { count: "exact" })
    .eq("form_id", formId)
    .order("submitted_at", { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) {
    return (
      <ResponsesSection>
        <QueryError what="this form's answers" message={error.message} />
      </ResponsesSection>
    );
  }

  const responses = data ?? [];
  const total = count ?? 0;

  /*
   * The names, in one query rather than a PostgREST embed.
   *
   * ⚠️ SOME OF THEM WILL BE MISSING, AND THAT IS CORRECT RATHER THAN A BUG. The
   * response policy scopes by the FORM's department; the `vizserve_pms_users`
   * policies scope by the READER's own. A company-wide survey owned by one
   * department collects answers from another, and its lead may read those
   * answers without being able to read the names on them. `ResponsesTable` says
   * so in the cell instead of showing a blank or a UUID.
   */
  const submitterIds = [...new Set(responses.map((response) => response.submitted_by))];

  const { data: users, error: usersError } = submitterIds.length
    ? await supabase.from("vizserve_pms_users").select("id, full_name").in("id", submitterIds)
    : { data: [], error: null };

  // Not fatal, and deliberately not grouped with the read above: a failed name
  // lookup costs the names, and hiding the answers because of it would be the
  // more damaging failure. It is logged so it is not merely invisible.
  if (usersError) {
    console.error("[P7-66] could not read response submitter names", {
      formId,
      message: usersError.message,
    });
  }

  const names = Object.fromEntries((users ?? []).map((user) => [user.id, user.full_name]));

  /*
   * ⚠️ THE COLUMNS ARE DERIVED FROM THE SCHEMA *AND* FROM THE ANSWERS ON THIS
   * PAGE. Archived fields keep a column because the schema still carries them;
   * a field that was DELETED outright keeps one because its key still turns up
   * in `field_values`. Either way, a column that vanishes takes its history
   * with it — see `responseColumns`.
   *
   * Scoped to the current page's answers, which is a real limitation and an
   * accepted one: an orphaned key that appears only on page 3 gets its column
   * on page 3. Scanning every response to build a stable column set would mean
   * reading the whole table on every page load, which is exactly what the
   * paging is for.
   */
  const fields = responseColumns(schema, answeredKeysOf(responses));

  const rows: ResponseRow[] = responses.map((response) => ({
    id: response.id,
    submitted_by: response.submitted_by,
    submitter_name: names[response.submitted_by] ?? null,
    submitted_at: response.submitted_at,
    field_values: response.field_values as Json,
  }));

  const basePath = `/forms/${formId}`;

  function hrefFor(target: number) {
    const query = new URLSearchParams();
    // The default stays out of the URL, so the everyday link is just the form.
    if (pageSize !== PAGE_SIZES[0]) query.set("size", String(pageSize));
    if (target > 1) query.set("page", String(target));
    const search = query.toString();
    return search ? `${basePath}?${search}` : basePath;
  }

  return (
    <ResponsesSection total={total}>
      {/*
        ⚠️ AN UNROUTED FORM'S ANSWERS ARE ADMIN-ONLY, because the policy asks
        `vizserve_pms_manages_department(department_id)` and that is true for an
        admin whatever it is passed and false for a lead on a null. Nothing
        stops a team leader publishing an engagement form before choosing its
        department — so the screen says why the table is empty rather than
        letting them conclude nobody has answered.
      */}
      {departmentId === null ? (
        <p className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs leading-relaxed text-warning">
          This form has no department yet, so only an admin can read its answers. Choose one under
          Settings and they will appear here.
        </p>
      ) : null}

      <ResponsesTable rows={rows} fields={fields} />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={hrefFor}
        basePath={basePath}
      />
    </ResponsesSection>
  );
}

/**
 * The panel the table sits in, shared by the loaded and the failed states so a
 * read failure does not change the shape of the page.
 *
 * The heading is an `h2`: the builder page's `h1` is the form name in the
 * header bar, and a section that is not in the heading order is a section a
 * screen-reader user cannot jump to.
 */
function ResponsesSection({
  total,
  children,
}: {
  total?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" aria-labelledby="form-responses-heading">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id="form-responses-heading" className="text-lg font-semibold tracking-[-0.014em]">
          Responses
        </h2>
        {total === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            <span className="tabular-nums">{total}</span>{" "}
            {total === 1 ? "answer" : "answers"}, newest first
          </p>
        )}
      </div>

      {children}
    </section>
  );
}

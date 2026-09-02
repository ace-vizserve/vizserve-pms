import { Info, TriangleAlert } from "lucide-react";

import { QueryError } from "@/components/query-error";
import type { Json } from "@/lib/database.types";
import { formatDateTime } from "@/lib/dates";
import type { FormSchema } from "@/lib/form-builder/builder";
import { summariseResponses } from "@/lib/form-builder/responses";
import { createClient } from "@/utils/supabase/server";

import { ExportAnswers } from "./export-answers";
import { ResponseViews, type ResponseRecord } from "./response-views";

/**
 * P7-66 — the Responses tab of an engagement form.
 *
 * Ace's ask, verbatim: "an internal form if youre an admin you can just gonna
 * click the form and have the view of submissions basically like google forms."
 * So it lives on the form, as a tab, rather than behind a second route somebody
 * has to know about.
 *
 * ⚠️ ENGAGEMENT FORMS ONLY, and the caller decides that. A CLIENT_REQUEST form's
 * submissions are `vizserve_pms_requests` and are read at /requests — with a
 * reference number, a status, a Gate 1 decision and an SLA clock, none of which
 * belongs here. `ClientRequestsPanel` is the other half.
 *
 * ⚠️⚠️ THE READ IS CAPPED AND UNPAGED, AND THAT IS A TRADE MADE ON PURPOSE.
 *
 * It used to be paged, twenty rows at a time, because it was a flat table and a
 * flat table can be. A SUMMARY cannot: "7 of 12 chose Home" is a statement about
 * every response, and computing it from twenty of them would produce a
 * confident, wrong number with nothing on screen to say so. The old note about
 * per-page columns said as much — an orphaned key appearing only on page 3 got
 * its column on page 3 — and that was survivable for a table and is not for a
 * count.
 *
 * So one read, ordered, capped, and the cap is STATED on the page whenever it
 * bites rather than silently truncating. The honest fix is aggregation in SQL —
 * a `group by` in a `SECURITY DEFINER` function, which is a migration and its
 * own ticket. Until then the numbers are right up to the cap and the page says
 * when they stop being.
 *
 * The cap is high enough that no form this platform will realistically see hits
 * it: this is one company's internal surveys, not a public panel.
 */
const RESPONSE_READ_CAP = 1000;

/**
 * How many ids to ask for in one `.in(...)`.
 *
 * Comfortably inside any gateway's URL limit with room for the rest of the
 * query, and small enough that one failing chunk costs a hundred names rather
 * than all of them.
 */
const NAME_LOOKUP_CHUNK = 100;

export async function FormResponses({
  formId,
  departmentId,
  isAnonymous,
  schema,
}: {
  formId: string;
  /** Null on an unrouted draft — see the note below. */
  departmentId: string | null;
  /**
   * ⚠️ THE FORM'S FLAG, AND THE ONLY THING THIS SCREEN MAY BRANCH ON.
   *
   * The tempting alternative — `rows.every((r) => r.submitted_by === null)` — is
   * wrong in the direction that matters. An empty page, or a page whose only
   * author is unreadable, satisfies that predicate and would relabel a NAMED
   * form as anonymous, telling the lead their survey collected no names when the
   * table is full of them. The flag is the form's property, it is what the
   * INSERT policy enforced, and it is locked once the form has an answer.
   */
  isAnonymous: boolean;
  /**
   * The form as the builder opened it — reconciled against the field rows, so
   * ARCHIVED FIELDS ARE PRESENT. That is what lets a question the form has
   * stopped asking still be summarised over the answers it collected.
   */
  schema: FormSchema;
}) {
  const supabase = await createClient();

  /*
   * No `.eq()` on anything but the form. `form responses readable by the owning
   * department` scopes the rows to an admin or the lead of the department that
   * owns this form — restating that here would imply the policy is optional
   * (CLAUDE.md).
   *
   * `submitted_at desc` is the order and the only order: newest first is what
   * makes a re-submission readable, since somebody who answered wrongly answers
   * again and both rows stand (there is no edit and no delete).
   *
   * `submitted_by` is selected on an anonymous form too, and stays every bit as
   * null as it was written. Dropping the column from the projection would be a
   * screen deciding not to look; the point is that there is nothing to look at.
   *
   * ⚠️ `count: "exact"` EVEN THOUGH THE ROWS ARE CAPPED. It is what lets the page
   * say "showing the first 1000 of 1400" rather than confidently reporting 1000.
   */
  const { data, count, error } = await supabase
    .from("vizserve_pms_form_responses")
    .select("id, submitted_by, field_values, submitted_at", { count: "exact" })
    .eq("form_id", formId)
    .order("submitted_at", { ascending: false })
    .limit(RESPONSE_READ_CAP);

  if (error) {
    return (
      <ResponsesSection>
        <QueryError what="this form's answers" message={error.message} />
      </ResponsesSection>
    );
  }

  const responses = data ?? [];
  const total = count ?? responses.length;

  /*
   * The names, in one query rather than a PostgREST embed.
   *
   * ⚠️ NOT ASKED FOR AT ALL ON AN ANONYMOUS FORM. `isAnonymous` short-circuits
   * before the filter, so the query is not merely empty — it is not made. There
   * is no id to look up, and a name lookup running over a form that promised not
   * to record one is the kind of line that later grows a fallback nobody meant
   * to write.
   *
   * ⚠️ SOME WILL BE MISSING ON A NAMED FORM, AND THAT IS CORRECT. The response
   * policy scopes by the FORM's department; the `vizserve_pms_users` policies
   * scope by the READER's own. A company-wide survey owned by one department
   * collects answers from another, and its lead may read those answers without
   * being able to read the names on them. The screen says so in the cell rather
   * than showing a blank or a UUID.
   *
   * `.filter(...)` narrows `(string | null)[]` to `string[]` for `.in()`, and is
   * a real guard rather than a cast: on a NAMED form every row has an author,
   * but the type cannot know that and neither can this file.
   */
  const submitterIds = isAnonymous
    ? []
    : [
        ...new Set(
          responses
            .map((response) => response.submitted_by)
            .filter((id): id is string => id !== null),
        ),
      ];

  /*
   * ⚠️ CHUNKED, BECAUSE THE ROW READ IS NO LONGER PAGED. `.in("id", ids)` becomes
   * a query STRING on a PostgREST GET, and it used to be bounded by a page of
   * twenty. It is now bounded only by the thousand-row cap — so a company-wide
   * survey with a few hundred distinct authors builds a URL past the gateway's
   * limit, the lookup fails WHOLESALE, and every row on a named form renders
   * "Outside your department".
   *
   * That failure is worse than it looks: the fallback is a claim about
   * PERMISSIONS. It would tell a lead that none of the people who answered their
   * survey is in their department, which is both false and unfalsifiable from
   * the screen.
   */
  const { data: users, error: usersError } = await readSubmitterNames(supabase, submitterIds);

  // Not fatal, and deliberately not grouped with the read above: a failed name
  // lookup costs the names, and hiding the answers because of it would be the
  // more damaging failure. Logged so it is not merely invisible.
  if (usersError) {
    console.error("[P7-66] could not read response submitter names", {
      formId,
      message: usersError.message,
    });
  }

  const names = Object.fromEntries((users ?? []).map((user) => [user.id, user.full_name]));

  const records: ResponseRecord[] = responses.map((response) => ({
    id: response.id,
    submitted_by: response.submitted_by,
    submitter_name:
      response.submitted_by === null ? null : (names[response.submitted_by] ?? null),
    submitted_at: response.submitted_at,
    field_values: response.field_values as Json,
  }));

  /*
   * ⚠️ AGGREGATED ON THE SERVER, NOT IN THE BROWSER. The three views all read
   * these counts, so computing them once here means switching views is free and
   * the browser is handed numbers rather than a pile of jsonb to add up. It is
   * also where the pure, tested rule lives — see `summariseResponses`.
   */
  const summaries = summariseResponses(schema, responses);

  const newest = records[0]?.submitted_at ?? null;

  return (
    <ResponsesSection>
      <div className="rounded-lg border bg-card p-5 grade-surface shadow-raised">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-3xl font-semibold tracking-[-0.02em] tabular-nums">
              {total} {total === 1 ? "answer" : "answers"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {/*
                ⚠️ "FROM N COLLEAGUES" IS A CLAIM AN ANONYMOUS FORM CANNOT MAKE,
                and not only because it has no names. The same person may answer
                twice — there is deliberately no unique index on (form_id,
                submitted_by) — so on a NAMED form this counts submissions and
                says so, and on an anonymous one even that much attribution is
                absent.
              */}
              {newest === null ? "Nothing yet" : `Last on ${formatDateTime(newest)}`}
            </p>
          </div>

          <ExportAnswers formId={formId} disabled={total === 0} />
        </div>

        <p
          className={
            isAnonymous
              ? "mt-3.5 flex gap-2.5 rounded-md border border-info-border bg-info-subtle px-3 py-2.5 text-xs leading-relaxed text-info"
              : "mt-3.5 flex gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-xs leading-relaxed text-warning"
          }
        >
          {isAnonymous ? (
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          ) : (
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          )}
          {isAnonymous ? (
            <span>
              <strong className="font-semibold">Anonymous.</strong> No name was recorded with any
              of these answers, so there is nobody to attribute them to — including for you. The
              count is all there is.
            </span>
          ) : (
            <span>
              <strong className="font-semibold">Not anonymous.</strong> Every answer names the
              person who wrote it. Only an admin and the lead of the owning department can read
              this page.
            </span>
          )}
        </p>

        {/*
          ⚠️ SAID WHENEVER IT BITES, NEVER SILENTLY. Past the cap the counts below
          describe the most recent 1000 answers and not the form — which is a
          defensible thing to show and an indefensible thing to show without
          saying. See `RESPONSE_READ_CAP`.
        */}
        {total > records.length ? (
          <p className="mt-2.5 flex gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-xs leading-relaxed text-warning">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Showing the most recent <span className="tabular-nums">{records.length}</span> of{" "}
              <span className="tabular-nums">{total}</span>. The counts below cover those, not the
              whole form.
            </span>
          </p>
        ) : null}

        {/*
          ⚠️ AN UNROUTED FORM'S ANSWERS ARE ADMIN-ONLY, because the policy asks
          `vizserve_pms_manages_department(department_id)` — true for an admin
          whatever it is passed, false for a lead on a null. Nothing stops a team
          leader publishing an engagement form before choosing its department, so
          the screen says why the page is empty rather than letting them conclude
          nobody has answered.
        */}
        {departmentId === null ? (
          <p className="mt-2.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs leading-relaxed text-warning">
            This form has no department yet, so only an admin can read its answers. Choose one
            under Settings and they will appear here.
          </p>
        ) : null}
      </div>

      <ResponseViews responses={records} summaries={summaries} isAnonymous={isAnonymous} />
    </ResponsesSection>
  );
}

/**
 * The submitters' names, read in chunks.
 *
 * ⚠️ ONE FAILING CHUNK IS NOT A FAILED LOOKUP. The chunks are independent, so a
 * partial answer is a page where most rows carry a name and a few say "outside
 * your department" — which is the state a named form is ALREADY in whenever the
 * reader's own department does not cover every author. Failing the whole lookup
 * because one chunk timed out would turn a hundred correct names into a hundred
 * false claims.
 *
 * The error is still returned, so the caller logs it. It is deliberately not
 * fatal: hiding the answers because a name did not arrive is the more damaging
 * of the two failures.
 */
async function readSubmitterNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<{ data: { id: string; full_name: string }[]; error: { message: string } | null }> {
  if (ids.length === 0) return { data: [], error: null };

  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += NAME_LOOKUP_CHUNK) {
    chunks.push(ids.slice(at, at + NAME_LOOKUP_CHUNK));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      supabase.from("vizserve_pms_users").select("id, full_name").in("id", chunk),
    ),
  );

  const data = results.flatMap((result) => result.data ?? []);
  const failure = results.find((result) => result.error)?.error ?? null;

  return { data, error: failure };
}

/**
 * The panel the views sit in, shared by the loaded and the failed states so a
 * read failure does not change the shape of the page.
 *
 * The heading is an `h2`: the builder page's `h1` is the form name in the header
 * bar, and a section that is not in the heading order is one a screen-reader
 * user cannot jump to.
 */
function ResponsesSection({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="mx-auto w-full max-w-4xl space-y-4 p-5"
      aria-labelledby="form-responses-heading"
    >
      <h2 id="form-responses-heading" className="sr-only">
        Responses
      </h2>
      {children}
    </section>
  );
}

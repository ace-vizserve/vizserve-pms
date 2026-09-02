import { Info, TriangleAlert, UserRoundX, Users } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { formatDateTime } from "@/lib/dates";
import {
  canShowPendingAnswerers,
  pendingAnswerers,
  type RosterMember,
} from "@/lib/form-builder/roster";
import { createClient } from "@/utils/supabase/server";

import { ExportAnswers } from "./export-answers";

/**
 * P7-66 Phase 4 — THE RESPONSES TAB OF AN INTERNAL FORM.
 *
 * Ace's ask, verbatim: "an internal form if youre an admin you can just gonna
 * click the form and have the view of submissions basically like google forms."
 * So it lives on the form, as a tab, rather than behind a second route somebody
 * has to know about.
 *
 * ⚠️ IT ANSWERS TWO QUESTIONS AND NOT A THIRD. How many answers there are, and
 * — on a named form — WHO GAVE THEM. It does not print the answers.
 *
 * Phase 3 built the third: per-question tallies, choice bars, date spans and a
 * Summary · Question · Individual switcher. Ace, on reading it: "no need to
 * capture all questions its hard to read it." Two reasons it went, and the
 * second is the one worth keeping written down:
 *
 *   IT WAS UNREADABLE AT THE SIZE THAT MATTERS. A twenty-question survey became
 *   a page of twenty stacked sections, and the thing somebody actually opens
 *   this tab for — has anybody answered, and who — was at the top of a long
 *   scroll nobody reads.
 *
 *   IT DUPLICATED THE EXPORT, WORSE. `exportFormResponses` already reads every
 *   response as the caller and writes every question's answers to a file, with
 *   archived and orphaned columns intact. The tab did the same job capped at a
 *   thousand rows. Two readings of one dataset that disagree past the cap is a
 *   trap, and the file is the half that can actually be analysed.
 *
 * So: the count and the people here, the answers in the CSV. Who has NOT
 * answered is Phase 6 — it needs the audience Phase 5 adds, because without a
 * roster "not answered" has no denominator.
 *
 * ⚠️ INTERNAL FORMS ONLY, and the caller decides that by not rendering the tab
 * at all otherwise. A CLIENT_REQUEST form's submissions are
 * `vizserve_pms_requests` and are read at /requests, which is the one place
 * requests are read. See `builderTabsFor`.
 */

/**
 * How many rows to read to build the people list.
 *
 * ⚠️ THE COUNT ITSELF IS NEVER CAPPED — it comes from `count: "exact"` and is
 * the true total whatever this is set to. The cap bounds only the WHO, and it is
 * stated on screen whenever it bites rather than silently truncating a list of
 * names. One company's internal surveys will not reach it.
 */
const PEOPLE_READ_CAP = 1000;

/**
 * How many ids to ask for in one `.in(...)`.
 *
 * Comfortably inside any gateway's URL limit with room for the rest of the
 * query, and small enough that one failing chunk costs a hundred names rather
 * than all of them.
 */
const NAME_LOOKUP_CHUNK = 100;

/** One person who answered, as the list renders them. */
type Answerer = {
  id: string;
  /** Null when the reader's own policies cannot resolve the name — see below. */
  name: string | null;
  /** How many times they answered. There is deliberately no unique index. */
  count: number;
  /** Their most recent submission. */
  last: string;
};

export async function FormResponses({
  formId,
  departmentId,
  isAnonymous,
  audience,
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
   * P7-66 Phase 6 — WHO SHOULD HAVE ANSWERED, as Phase 5 stored it.
   *
   * The roster of "who has not answered" is derived from exactly this, and it is
   * why Phase 6 could not be built before Phase 5: without an audience,
   * "not answered" would have meant the whole company minus this list, which is
   * a number that means nothing.
   */
  audience: { isAllDepartments: boolean; departmentIds: string[] };
}) {
  const supabase = await createClient();

  /*
   * ⚠️ WHICH COLUMNS ARE EVEN ASKED FOR DEPENDS ON THE FORM, so the read is two
   * functions rather than one query with a `?:` in its `select`. See
   * `readNamedRows` / `readAnonymousRows` below — the reason is not style.
   */
  const { rows, count, error } = isAnonymous
    ? await readAnonymousRows(supabase, formId)
    : await readNamedRows(supabase, formId);

  if (error) {
    return (
      <ResponsesSection>
        <QueryError what="this form's answers" message={error.message} />
      </ResponsesSection>
    );
  }

  const total = count ?? rows.length;
  const newest = rows[0]?.submitted_at ?? null;

  /*
   * P7-66 Phase 8 — the marked answers, and what they averaged.
   *
   * `score !== null` is the test, never `score > 0` and never `?? 0`: null means
   * the form was not a quiz when this answer was written, and 0 means it was and
   * the person got nothing right. See the note on `ResponseRow`.
   *
   * `max_score` is read off the first marked row rather than recomputed from the
   * form's current fields — the answer key may have been edited since, and the
   * total somebody was actually marked out of is the one stored on their row.
   * (Answers marked against two different totals would make an average of raw
   * scores misleading; that is a real case and is not solved here, which is why
   * the sentence names the denominator it used.)
   */
  const marked = rows.filter((row) => row.score !== null);

  const averageScore =
    marked.length === 0
      ? "0"
      : (marked.reduce((sum, row) => sum + (row.score ?? 0), 0) / marked.length).toFixed(1);

  /*
   * One entry per person, newest first — the order the rows arrived in, which is
   * `submitted_at desc`, so the list leads with whoever answered most recently.
   *
   * ⚠️ COUNTED PER PERSON BECAUSE THE SAME PERSON MAY ANSWER TWICE. There is
   * deliberately no unique index on (form_id, submitted_by): a colleague who
   * answered wrongly answers again and both rows stand. So "12 answers" and "9
   * people" are different numbers, and the page shows both rather than implying
   * they are the same one.
   */
  const byPerson = new Map<string, { count: number; last: string }>();

  for (const row of rows) {
    const id = row.submitted_by;
    if (!id) continue;

    const seen = byPerson.get(id);
    if (seen) seen.count += 1;
    else byPerson.set(id, { count: 1, last: row.submitted_at });
  }

  /*
   * ⚠️ CHUNKED. `.in("id", ids)` becomes a query STRING on a PostgREST GET, and
   * it is bounded here only by the thousand-row cap — so a company-wide survey
   * with a few hundred distinct authors builds a URL past the gateway's limit
   * and the lookup fails WHOLESALE. Every name on the page would then read
   * "Name unavailable", on a page whose entire subject is who answered.
   */
  const { data: users, error: usersError } = await readSubmitterNames(supabase, [
    ...byPerson.keys(),
  ]);

  // Not fatal, and deliberately not grouped with the read above: a failed name
  // lookup costs the names, and hiding the count because of it would be the
  // more damaging failure. Logged so it is not merely invisible.
  if (usersError) {
    console.error("[P7-66] could not read response submitter names", {
      formId,
      message: usersError.message,
    });
  }

  const names = Object.fromEntries((users ?? []).map((user) => [user.id, user.full_name]));

  /*
   * ⚠️ A MISSING NAME IS NOW A LOOKUP FAILURE, NOT A PERMISSIONS FACT — P7-66
   * Phase 5 CHANGED WHAT THIS MEANS, and the sentence on screen changed with it.
   *
   * It used to be routine: the response policy scoped by the FORM's department
   * and the `vizserve_pms_users` policies by the READER's own, so a lead reading
   * a company-wide survey legitimately could not resolve half the authors.
   * `form responses readable by admins` (20260902140000) ended that — only an
   * admin reaches this page, and an admin reads every department's people. So a
   * gap here means a chunk of the lookup failed, which is worth saying plainly
   * rather than blaming on a department boundary that no longer applies.
   *
   * The branch STAYS, because the failure it now describes is real: see
   * `readSubmitterNames`, where one chunk can fail while the others succeed.
   * They are counted and shown as unnamed rather than dropped — a person missing
   * from the list would make the people count disagree with the list under it.
   */
  const answerers: Answerer[] = [...byPerson.entries()].map(([id, tally]) => ({
    id,
    name: names[id] ?? null,
    count: tally.count,
    last: tally.last,
  }));

  const unnamed = answerers.filter((person) => person.name === null).length;

  /*
   * P7-66 Phase 6 — THE ROSTER.
   *
   * ⚠️ NOT ASKED FOR ON AN ANONYMOUS FORM, and the guard is before the query
   * rather than around the render. See `canShowPendingAnswerers`: the answer
   * would be the ENTIRE audience, because no row carries an author — a page
   * telling an admin that nobody has answered, beside a count of four hundred.
   * Not fetching it is how that stays impossible rather than merely unrendered.
   */
  const { roster, error: rosterError } = canShowPendingAnswerers(isAnonymous)
    ? await readRoster(supabase, audience)
    : { roster: [], error: null };

  /*
   * Not fatal, and deliberately not grouped with the response read: a failed
   * roster costs the "who has not answered" list, and hiding the answers because
   * of it would be the more damaging failure. The section says so itself rather
   * than rendering an empty list, which would read as "everybody answered".
   */
  if (rosterError) {
    console.error("[P7-66] could not read the form audience roster", {
      formId,
      message: rosterError.message,
    });
  }

  const pending = pendingAnswerers(roster, byPerson.keys());

  return (
    <ResponsesSection>
      <div className="rounded-lg border bg-card p-5 grade-surface shadow-raised">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-3xl font-semibold tracking-[-0.02em] tabular-nums">
              {total} {total === 1 ? "answer" : "answers"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {newest === null ? "Nothing yet" : `Last on ${formatDateTime(newest)}`}
              {/*
                ⚠️ THE PEOPLE COUNT IS A SECOND NUMBER, NOT A RE-PHRASING OF THE
                FIRST: the same colleague may answer twice, so twelve answers can
                be nine people. An anonymous form cannot make this claim at all —
                not because the names are withheld, but because none was written,
                so there is no way to tell one answer from two by one person.
              */}
              {isAnonymous || answerers.length === 0
                ? null
                : ` · ${answerers.length} ${answerers.length === 1 ? "person" : "people"}`}
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
              person who wrote it. Only an admin can read this page.
            </span>
          )}
        </p>

        {/*
          P7-66 Phase 8 — HOW THE QUIZ WENT, IN ONE LINE.

          ⚠️ IT COUNTS ONLY THE ANSWERS THAT WERE ACTUALLY MARKED. A response
          carries NULL when the form was not a quiz at the moment it was
          answered, and treating that as a zero would drag the average down every
          time somebody turned marking on part-way through a live form. The
          denominator is stated for the same reason: "average 7.2 of 10 across 9
          marked answers" cannot be misread the way a bare 7.2 can.

          Rendered from the rows this page already read, so it costs no query —
          and it is capped by the same PEOPLE_READ_CAP, which the sentence admits
          rather than quietly averaging the most recent thousand and calling it
          the average.
        */}
        {marked.length > 0 ? (
          <p className="mt-2.5 rounded-md border border-accent-border bg-accent px-3 py-2 text-xs leading-relaxed text-accent-foreground">
            <strong className="font-semibold">
              Average {averageScore} of {marked[0]!.max_score ?? 0}
            </strong>{" "}
            across {marked.length} marked answer{marked.length === 1 ? "" : "s"}
            {marked.length < total
              ? `. ${total - marked.length} answer${total - marked.length === 1 ? " was" : "s were"} given before this form was marked, and stay unscored.`
              : "."}
          </p>
        ) : null}

        {/*
          ⚠️ THE ANSWERS ARE IN THE FILE, AND THE PAGE SAYS SO RATHER THAN
          LEAVING IT TO BE GUESSED. A tab headed "Responses" that prints no
          response reads as broken unless it says where they went.
        */}
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          The answers themselves are in the CSV export — every question, including any you have
          archived since.
        </p>

        {/*
          ⚠️ AN UNROUTED FORM'S ANSWERS ARE ADMIN-ONLY, because the policy asks
          `vizserve_pms_manages_department(department_id)` — true for an admin
          whatever it is passed, false for a lead on a null. Nothing stops a team
          leader publishing an internal form before choosing its department, so
          the screen says why the page is empty rather than letting them conclude
          nobody has answered.
        */}
        {/*
          ⚠️ NOT ABOUT READING THE ANSWERS ANY MORE — P7-66 Phase 5 made that
          admin-only whatever the department is, so the old sentence ("only an
          admin can read its answers") became true of every form and stopped
          being news. What an unrouted form still cannot do is PUBLISH
          (`vizserve_pms_forms_active_requires_department`), which is the reason
          the page is empty on a draft nobody can reach.
        */}
        {departmentId === null ? (
          <p className="mt-2.5 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs leading-relaxed text-warning">
            This form has no department yet, so it cannot be published and nobody can answer it.
            Choose one under Settings.
          </p>
        ) : null}
      </div>

      {isAnonymous ? null : (
        <Answerers answerers={answerers} unnamed={unnamed} total={total} read={rows.length} />
      )}

      {canShowPendingAnswerers(isAnonymous) ? (
        <Pending
          pending={pending}
          rosterSize={roster.length}
          failed={rosterError !== null}
          capped={total > rows.length}
        />
      ) : null}
    </ResponsesSection>
  );
}

/**
 * Who answered.
 *
 * ⚠️ NOT WHO HAS NOT. That list is Phase 6 and it needs the audience Phase 5
 * adds: today a published internal form is answerable by every signed-in
 * colleague, so "not answered" would be the whole company minus this list — a
 * roster nobody asked for and a number that means nothing.
 */
function Answerers({
  answerers,
  unnamed,
  total,
  read,
}: {
  answerers: Answerer[];
  unnamed: number;
  total: number;
  /** How many rows the cap let us look at, for the truncation notice. */
  read: number;
}) {
  if (answerers.length === 0) {
    return (
      <div className="rounded-lg border bg-card grade-surface shadow-raised">
        <EmptyState
          icon={<Users />}
          title="Nobody has answered yet"
          description="Answers appear here as colleagues fill the form in. Publish it, then share the link from the top of this page."
        />
      </div>
    );
  }

  return (
    <section className="rounded-lg border bg-card grade-surface shadow-raised">
      <h3 className="border-b px-5 py-3 text-sm font-semibold tracking-tight">Who answered</h3>

      {/*
        ⚠️ SAID WHENEVER IT BITES, NEVER SILENTLY. Past the cap this list covers
        the most recent answers and not the form. The COUNT above is still exact
        — it comes from the database, not from this array — so the sentence has
        to say which of the two numbers is the partial one.
      */}
      {total > read ? (
        <p className="flex gap-2.5 border-b border-warning-border bg-warning-subtle px-5 py-2.5 text-xs leading-relaxed text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Built from the most recent <span className="tabular-nums">{read}</span> of{" "}
            <span className="tabular-nums">{total}</span> answers. Somebody who answered only
            earlier than those is missing from this list.
          </span>
        </p>
      ) : null}

      <ul className="divide-y">
        {answerers.map((person) => (
          <li key={person.id} className="flex items-center gap-4 px-5 py-2.5">
            <span
              className={
                person.name === null
                  ? "min-w-0 flex-1 truncate text-sm text-muted-foreground"
                  : "min-w-0 flex-1 truncate text-sm"
              }
            >
              {/* Never a UUID and never a blank. See the note on `names`: this
                  is a failed lookup, not a statement about the answer, which is
                  counted either way. */}
              {person.name ?? "Name unavailable"}
            </span>
            {person.count > 1 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {person.count} answers
              </span>
            ) : null}
            <time
              dateTime={person.last}
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
            >
              {formatDateTime(person.last)}
            </time>
          </li>
        ))}
      </ul>

      {unnamed > 0 ? (
        <p className="border-t px-5 py-2.5 text-xs leading-relaxed text-warning">
          <span className="tabular-nums">{unnamed}</span>{" "}
          {unnamed === 1 ? "name" : "names"} could not be looked up. The answers are counted and
          are in the export; only the lookup failed, so a reload may well fix it.
        </p>
      ) : null}
    </section>
  );
}

/** One response, reduced to the facts this tab needs. */
type ResponseRow = {
  submitted_by: string | null;
  submitted_at: string;
  /**
   * P7-66 Phase 8 — what this answer scored, or NULL if the form was not a quiz
   * WHEN IT WAS ANSWERED.
   *
   * ⚠️ NULL AND 0 ARE DIFFERENT AND MUST STAY DIFFERENT. Null is "never
   * marked"; 0 is "marked, got nothing right". Averaging them together would
   * drag a quiz's average down every time somebody turned marking on part-way
   * through, which is exactly the case the stored score exists to keep honest.
   */
  score: number | null;
  max_score: number | null;
};

type RowsRead = {
  rows: ResponseRow[];
  /** The TRUE total, from `count: "exact"` — never capped. See `PEOPLE_READ_CAP`. */
  count: number | null;
  error: { message: string } | null;
};

/**
 * The rows of a NAMED form.
 *
 * No `.eq()` on anything but the form. `form responses readable by the owning
 * department` scopes them to an admin or the lead of the department that owns
 * this form — restating that here would imply the policy is optional (CLAUDE.md).
 *
 * ⚠️ `field_values` IS NOT SELECTED. Nothing on this tab reads an answer any
 * more, and a projection that fetched them anyway would ship every response body
 * into the RSC payload in order to render a number. The export reads them,
 * server-side, when somebody asks for the file.
 *
 * `submitted_at desc` is the order: newest first is what makes a re-submission
 * readable, since somebody who answered wrongly answers again and both rows
 * stand (there is no edit and no delete).
 *
 * ⚠️ `count: "exact"` EVEN THOUGH THE ROWS ARE CAPPED. It is what lets the page
 * report the true total and say separately that the list of NAMES covers only
 * the most recent thousand.
 */
async function readNamedRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  formId: string,
): Promise<RowsRead> {
  const { data, count, error } = await supabase
    .from("vizserve_pms_form_responses")
    .select("submitted_by, submitted_at, score, max_score", { count: "exact" })
    .eq("form_id", formId)
    .order("submitted_at", { ascending: false })
    .limit(PEOPLE_READ_CAP);

  return { rows: data ?? [], count, error };
}

/**
 * The rows of an ANONYMOUS form.
 *
 * ⚠️ `submitted_by` IS NOT IN THE PROJECTION, AND THAT IS THE WHOLE FUNCTION.
 * It is null on every row — the INSERT policy refused to let a name be written —
 * so selecting it would be a screen going to look for something it has been
 * promised is not there, and the null it got back would be indistinguishable
 * from a name it merely failed to read. The author is supplied as null HERE, by
 * construction, rather than trusted from a column.
 *
 * ⚠️ AND IT IS A SEPARATE FUNCTION RATHER THAN A `?:` INSIDE ONE `.select()`.
 * postgrest-js types the rows from the STRING LITERAL, so a conditional
 * projection types as a parser error that has to be cast away — and the cast is
 * exactly what would stop anybody noticing if this branch started asking for the
 * column again.
 */
async function readAnonymousRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  formId: string,
): Promise<RowsRead> {
  const { data, count, error } = await supabase
    .from("vizserve_pms_form_responses")
    /* `score` and `max_score` are the form's marking, not the person's identity
       — an anonymous quiz still has an average, and reading them here breaks no
       promise. `submitted_by` stays out; see the note above. */
    .select("submitted_at, score, max_score", { count: "exact" })
    .eq("form_id", formId)
    .order("submitted_at", { ascending: false })
    .limit(PEOPLE_READ_CAP);

  return {
    rows: (data ?? []).map((row) => ({
      submitted_by: null,
      submitted_at: row.submitted_at,
      score: row.score,
      max_score: row.max_score,
    })),
    count,
    error,
  };
}

/**
 * P7-66 Phase 6 — THE PEOPLE THE FORM IS FOR.
 *
 * ⚠️⚠️ THIS QUERY IS THE SQL TWIN OF `vizserve_pms_form_targets_me`, AND IF THE
 * TWO EVER DISAGREE THIS PAGE LIES.
 *
 * The function decides who may ANSWER; this decides who is EXPECTED to. A person
 * the function admits but this query misses never appears as outstanding, so an
 * admin closes a survey believing everybody replied. A person this query
 * includes but the function refuses gets chased for an answer they are not
 * allowed to give. Rule for rule, the function reads:
 *
 *   f.audience_is_all_departments
 *   or exists (… a.department_id = u.primary_department_id)
 *
 * so:
 *   ALL DEPARTMENTS  no department filter at all — which INCLUDES somebody whose
 *                    `primary_department_id` is null, because the function's
 *                    first branch never looks at their department either.
 *   SPECIFIC         `.in(...)`, which excludes a null exactly as the function's
 *                    `=` does. Neither admits an unassigned person.
 *
 * ⚠️ `is_active` AND `app_access` ARE PART OF THE TWIN, not tidying. The function
 * is only ever ANDed with policies that ran `vizserve_pms_current_role()` first,
 * and that returns NULL — no role, no read, no insert — for a deactivated user
 * or one without `vizserve-pms` in `app_access`. Somebody who cannot sign into
 * this app at all is not outstanding; they are not in the audience.
 *
 * ⚠️ READ AS THE CALLER, THROUGH RLS, AND THAT IS SAFE ONLY BECAUSE OF PHASE 5.
 * `users read managed departments` is `vizserve_pms_manages_department(...)`,
 * which is TRUE for an admin on every department — and since 20260902140000 only
 * an admin reaches this page at all. This is exactly why the roster needed
 * internal forms to become admin-only first: read by a team leader, the policy
 * would silently drop every colleague outside the departments they lead, and the
 * list would be confidently, invisibly short.
 */
async function readRoster(
  supabase: Awaited<ReturnType<typeof createClient>>,
  audience: { isAllDepartments: boolean; departmentIds: string[] },
): Promise<{ roster: RosterMember[]; error: { message: string } | null }> {
  /*
   * ⚠️ AN EMPTY LIST UNDER "SPECIFIC DEPARTMENTS" IS NOBODY, NOT EVERYBODY, and
   * it short-circuits rather than issuing an `.in(…, [])`.
   *
   * It is a state the database can reach without anybody asking for it — a
   * department deleted elsewhere cascades its audience row away — and
   * `vizserve_pms_form_targets_me` answers false for every caller when it
   * happens, so the form is answerable by nobody. The roster must agree.
   * Answering "everybody" here would list the whole company as outstanding on a
   * form none of them can open.
   */
  if (!audience.isAllDepartments && audience.departmentIds.length === 0) {
    return { roster: [], error: null };
  }

  const query = supabase
    .from("vizserve_pms_users")
    .select("id, full_name, primary_department_id")
    .eq("is_active", true)
    .contains("app_access", ["vizserve-pms"]);

  if (!audience.isAllDepartments) query.in("primary_department_id", audience.departmentIds);

  const { data, error } = await query.order("full_name");

  return { roster: data ?? [], error };
}

/**
 * Who has not answered.
 *
 * ⚠️ NEVER RENDERED ON AN ANONYMOUS FORM — the caller checks
 * `canShowPendingAnswerers` before the roster is even fetched. See that function
 * for why that is a correctness rule rather than a preference.
 */
function Pending({
  pending,
  rosterSize,
  failed,
  capped,
}: {
  pending: RosterMember[];
  rosterSize: number;
  /** The roster read failed — see below on why that is not an empty list. */
  failed: boolean;
  /**
   * The ANSWERS were capped, so the set of authors may be short — which would
   * put somebody on this list who did answer. Said out loud when it can happen.
   */
  capped: boolean;
}) {
  /*
   * ⚠️ A FAILED READ IS NOT "EVERYBODY ANSWERED". Both states produce an empty
   * array, and one of them is the most encouraging screen this tab can show. So
   * the failure is drawn as a failure.
   */
  if (failed) {
    return (
      <PendingSection>
        <p className="flex gap-2.5 px-5 py-3 text-xs leading-relaxed text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            The list of people this form was sent to could not be read, so this is not a
            statement that everybody answered. Reload the page.
          </span>
        </p>
      </PendingSection>
    );
  }

  /*
   * Nobody is in the audience at all — worth distinguishing from "everybody
   * answered", and reachable two ways: a form narrowed to departments that have
   * since been emptied or deleted, and a form whose audience rows were lost
   * while the flag still says "specific departments".
   */
  if (rosterSize === 0) {
    return (
      <PendingSection>
        <p className="flex gap-2.5 px-5 py-3 text-xs leading-relaxed text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Nobody is in this form&rsquo;s audience, so nobody can answer it. Check who it is for
            under Settings.
          </span>
        </p>
      </PendingSection>
    );
  }

  if (pending.length === 0) {
    return (
      <PendingSection>
        <p className="px-5 py-3 text-sm">
          Everyone the form was sent to has answered
          <span className="text-muted-foreground"> — all {rosterSize} of them.</span>
        </p>
      </PendingSection>
    );
  }

  return (
    <PendingSection
      count={
        <span className="font-normal tabular-nums text-muted-foreground">
          {pending.length} of {rosterSize}
        </span>
      }
    >
      {/*
        ⚠️ SAID WHENEVER THE ANSWERS WERE CAPPED. The authors come from the capped
        read, so past the cap somebody who answered long ago is missing from that
        set — and therefore appears HERE, on the one list whose whole purpose is
        to be chased. Wrong in the direction that costs somebody an awkward
        conversation about a form they already filled in.
      */}
      {capped ? (
        <p className="flex gap-2.5 border-b border-warning-border bg-warning-subtle px-5 py-2.5 text-xs leading-relaxed text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            This form has more answers than the page reads at once, so somebody who answered
            early may be listed here by mistake. Check the export before chasing anyone.
          </span>
        </p>
      ) : null}

      <ul className="divide-y">
        {pending.map((person) => (
          <li key={person.id} className="px-5 py-2.5 text-sm">
            {person.full_name.trim() === "" ? (
              // `full_name` defaults to '' on the column, so somebody invited but
              // never set up would otherwise render as a blank row — a
              // name-shaped hole in a list of names.
              <span className="text-muted-foreground">Unnamed account</span>
            ) : (
              person.full_name
            )}
          </li>
        ))}
      </ul>
    </PendingSection>
  );
}

/** The panel, shared by all four states so none of them changes the page shape. */
function PendingSection({
  count,
  children,
}: {
  count?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card grade-surface shadow-raised">
      <h3 className="flex items-baseline gap-2 border-b px-5 py-3 text-sm font-semibold tracking-tight">
        <UserRoundX aria-hidden className="size-4 self-center text-muted-foreground" />
        Who hasn&rsquo;t answered
        {count}
      </h3>
      {children}
    </section>
  );
}

/**
 * The submitters' names, read in chunks.
 *
 * ⚠️ ONE FAILING CHUNK IS NOT A FAILED LOOKUP. The chunks are independent, so a
 * partial answer is a page where most rows carry a name and a few do not.
 * Failing the whole lookup because one chunk timed out would blank a hundred
 * names that arrived perfectly well, and the page would then have to describe
 * every one of them as unavailable.
 *
 * The error is still returned, so the caller logs it. It is deliberately not
 * fatal: hiding the count because a name did not arrive is the more damaging of
 * the two failures.
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
 * The panel the summary sits in, shared by the loaded and the failed states so a
 * read failure does not change the shape of the page.
 *
 * The heading is an `h2`: the builder page's `h1` is the form name in the header
 * bar, and a section that is not in the heading order is one a screen-reader
 * user cannot jump to.
 */
function ResponsesSection({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="mx-auto w-full max-w-3xl space-y-4 p-5"
      aria-labelledby="form-responses-heading"
    >
      <h2 id="form-responses-heading" className="sr-only">
        Responses
      </h2>
      {children}
    </section>
  );
}

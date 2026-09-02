"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";

import { Monogram } from "@/app/(app)/tasks/assignees";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatDateTime } from "@/lib/dates";
import {
  answerFor,
  responseViewsFor,
  type QuestionSummary,
  type ResponseView,
} from "@/lib/form-builder/responses";
import type { Json } from "@/lib/database.types";

/**
 * P7-66 — READING A STAFF FORM'S ANSWERS, THREE WAYS.
 *
 * The flat table this replaces said, correctly at the time, that there was "no
 * chart, no aggregation and no per-question summary, because none of that was
 * asked for and every one of them is a decision about what the numbers MEAN".
 * They are asked for now, and the decisions live in `summariseResponses` —
 * pure, tested, and in one place rather than spread across this file.
 *
 * Three views, because there are three genuinely different questions somebody
 * opens this tab to answer:
 *
 *   SUMMARY     what did people say, overall? Counts and bars per question.
 *   QUESTION    what did everyone say to THIS one? Every answer, in full.
 *   INDIVIDUAL  what did ONE person say? Their whole submission.
 *
 * ⚠️ THERE IS NO INDIVIDUAL VIEW ON AN ANONYMOUS FORM, because there is no
 * individual to show. `submitted_by` is NULL on every row — the INSERT policy
 * refused to let a name be written — so the view would page through submissions
 * headed "somebody", with a monogram it cannot draw and a name it cannot print.
 *
 * It is NOT a claim that reading one submission's answers together is prevented:
 * one response is one `field_values` blob, so the grouping is the row, and it is
 * in the CSV and in this page's own payload. See `responseViewsFor` for what
 * anonymity here does and does not mean.
 *
 * ⚠️ CLIENT-SIDE, OVER RESPONSES THE SERVER ALREADY LOADED. All three views read
 * the same array, so switching between them is instant and costs no query — and
 * `summariseResponses` has already run on the server, so the browser is handed
 * counts rather than a pile of blobs to add up. The cap on that read is stated
 * on the page; see `FormResponses`.
 */

export type ResponseRecord = {
  id: string;
  /** Null on an anonymous form — no name was ever written. */
  submitted_by: string | null;
  /** Null when anonymous, and null when the reader cannot see that user row. */
  submitter_name: string | null;
  submitted_at: string;
  field_values: Json;
};



export function ResponseViews({
  responses,
  summaries,
  isAnonymous,
}: {
  /** Newest first, as the query ordered them. */
  responses: ResponseRecord[];
  /** One per question, computed on the server. */
  summaries: QuestionSummary[];
  isAnonymous: boolean;
}) {
  const [view, setView] = useState<ResponseView>("summary");

  /*
   * ⚠️ THE TAB LIST IS BUILT FROM THE FORM'S FLAG, so Individual cannot be
   * reached on an anonymous form by any route — not by clicking, not by a stale
   * piece of state, not by a keyboard arrow through the tab strip. Rendering it
   * disabled would advertise a view that exists for other forms and invite the
   * question of why this one is different; the answer is that it does not exist
   * here at all.
   */
  const offered = responseViewsFor(isAnonymous);

  const LABELS: Record<ResponseView, string> = {
    summary: "Summary",
    question: "Question",
    individual: "Individual",
  };

  /*
   * ⚠️ FALLING BACK TO SUMMARY IS NOT DEFENSIVE PADDING. `isAnonymous` is fixed
   * for the life of the form, but this component re-renders on every
   * `router.refresh()` and the state outlives them — so the fallback is what
   * guarantees a view that is not offered can never be the one on screen,
   * whatever route the state took to get there.
   */
  const active = offered.includes(view) ? view : "summary";

  if (responses.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="No answers yet"
        description={
          isAnonymous
            ? "Answers appear here as soon as somebody fills the form in, without a name against them. Staff reach it from Fill a form in the sidebar — it has to be published first."
            : "Answers appear here as soon as somebody fills the form in. Staff reach it from Fill a form in the sidebar — it has to be published first."
        }
      />
    );
  }

  /*
   * ⚠️ THE REPO'S `Tabs` PRIMITIVE, NOT A HAND-ROLLED `role="tablist"`.
   *
   * This was three `<button role="tab">`s with `aria-selected` and nothing else,
   * which is the half of the tabs pattern that is easy to write and the wrong
   * half to stop at. What was missing is what a screen-reader or keyboard user
   * actually needs: `role="tabpanel"` on the content, `aria-controls` tying the
   * two together, and — the one that makes it unusable rather than merely
   * unlabelled — roving tabindex with arrow-key movement, so a tab strip is one
   * Tab stop you arrow through rather than three you Tab past.
   *
   * Base UI does all of it, `components/ui/tabs.tsx` already wraps it, and the
   * strip enclosing this whole panel (`BuilderTabs`) already uses it. Two tab
   * patterns on one screen, one of them broken, is worse than either.
   */
  return (
    <Tabs
      value={active}
      onValueChange={(value) => setView(value as ResponseView)}
      className="gap-0 rounded-lg border bg-card grade-surface shadow-raised"
    >
      <TabsList
        variant="line"
        aria-label="How to read the answers"
        className="h-auto w-full justify-start rounded-none border-b px-3 py-0"
      >
        {offered.map((item) => (
          <TabsTrigger key={item} value={item} className="h-auto flex-none px-3.5 py-2.5">
            {LABELS[item]}
          </TabsTrigger>
        ))}
      </TabsList>

      {/*
        Not `keepMounted`, unlike the page-level strip. Those panels hold the
        builder store and unmounting one would discard an edit; these three are
        derived views over the same props, so remounting costs a render and
        nothing else — and it resets the Individual view's position to the first
        answer, which is where somebody returning to it expects to be.
      */}
      <TabsContent value="summary" className="p-4">
        <SummaryView responses={responses} summaries={summaries} isAnonymous={isAnonymous} />
      </TabsContent>
      <TabsContent value="question" className="p-4">
        <QuestionView responses={responses} summaries={summaries} isAnonymous={isAnonymous} />
      </TabsContent>
      {/*
        Not rendered at all when it is not offered. Base UI would keep a panel
        whose tab does not exist as inert markup, and inert markup for a view
        that cannot work is a thing to trip over later — not a leak: the same
        rows are in this component's props either way.
      */}
      {offered.includes("individual") ? (
        <TabsContent value="individual" className="p-4">
          <IndividualView responses={responses} summaries={summaries} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------

function SummaryView({
  responses,
  summaries,
  isAnonymous,
}: {
  responses: ResponseRecord[];
  summaries: QuestionSummary[];
  isAnonymous: boolean;
}) {
  if (summaries.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="Nothing to summarise"
        description="This form has no questions yet, so there is nothing for anybody to answer."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {summaries.map((summary) => (
        <section key={summary.column.key} className="rounded-lg border px-4 py-3.5">
          <QuestionHeading summary={summary} />

          {summary.kind === "choice" ? <ChoiceBars summary={summary} /> : null}
          {summary.kind === "date" ? <DateSpan summary={summary} /> : null}
          {summary.kind === "text" ? (
            <TextAnswers
              summary={summary}
              responses={responses}
              isAnonymous={isAnonymous}
              limit={3}
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}

/**
 * The question, and how many people answered it.
 *
 * ⚠️ THE SKIPPING IS ON SCREEN, NOT BURIED IN THE ARITHMETIC. Every percentage
 * below is against the number who ANSWERED, so "4 skipped" is the only thing
 * that says the question was optional and a third of the room passed on it.
 *
 * Archived and orphaned questions are marked in the word, not by a colour —
 * they look identical to a live question otherwise, which is exactly the
 * confusion worth spending eight characters on.
 */
function QuestionHeading({ summary }: { summary: QuestionSummary }) {
  return (
    <>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <span>{summary.column.label}</span>
        {summary.column.origin === "archived" ? (
          <span className="text-2xs font-normal text-muted-foreground">(archived)</span>
        ) : null}
        {summary.column.origin === "orphan" ? (
          <span className="text-2xs font-normal text-muted-foreground">(removed)</span>
        ) : null}
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        <span className="tabular-nums">{summary.answered}</span>{" "}
        {summary.answered === 1 ? "answer" : "answers"}
        {summary.blank > 0 ? (
          <>
            {" · "}
            <span className="tabular-nums">{summary.blank}</span> skipped
          </>
        ) : null}
      </p>
    </>
  );
}

function ChoiceBars({ summary }: { summary: Extract<QuestionSummary, { kind: "choice" }> }) {
  if (summary.tallies.length === 0) {
    return <p className="text-xs text-muted-foreground">This question offers no choices.</p>;
  }

  return (
    <ul className="space-y-0.5">
      {summary.tallies.map((tally) => {
        /*
         * ⚠️ THE DENOMINATOR IS THE NUMBER WHO ANSWERED THIS QUESTION, not the
         * number of responses and not the sum of the tallies. See the note in
         * `summariseResponses`: against the response count the bars would sum to
         * less than 100% on any optional question with nothing saying why, and
         * against the sum a multiselect's "60% chose Home" would silently become
         * "Home is 30% of all selections", which is a different claim.
         */
        const percent =
          summary.answered === 0 ? 0 : Math.round((tally.count / summary.answered) * 100);

        return (
          <li key={tally.option} className="grid grid-cols-[minmax(90px,26%)_1fr_auto] items-center gap-2.5 py-1 text-xs">
            <span className="min-w-0 truncate" title={tally.option}>
              {tally.option}
              {tally.offered ? null : (
                // An answer under a choice the form has since dropped. Kept and
                // marked — see `tally`.
                <span className="text-muted-foreground"> (no longer offered)</span>
              )}
            </span>
            <span className="h-5 overflow-hidden rounded-sm bg-track">
              <span
                className="block h-full rounded-sm bg-primary"
                style={{ width: `${percent}%` }}
              />
            </span>
            <span className="min-w-14 text-right text-2xs text-muted-foreground tabular-nums">
              {tally.count} · {percent}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DateSpan({ summary }: { summary: Extract<QuestionSummary, { kind: "date" }> }) {
  if (summary.earliest === null || summary.latest === null) {
    return <p className="text-xs text-muted-foreground">Nobody has given a date.</p>;
  }

  return (
    <p className="text-xs text-muted-foreground">
      Earliest {formatDate(summary.earliest)} · latest {formatDate(summary.latest)}
    </p>
  );
}

/**
 * Free-text answers.
 *
 * ⚠️ WHO WROTE IT IS ATTACHED HERE, NOT IN THE SUMMARY. `summariseResponses`
 * returns an index into the response array and nothing else — so the pure
 * aggregation never touches a name, and this is the only place that decides
 * whether one is shown. On an anonymous form there is no name to attach; the
 * timestamp stands alone.
 */
function TextAnswers({
  summary,
  responses,
  isAnonymous,
  limit,
}: {
  summary: Extract<QuestionSummary, { kind: "text" }>;
  responses: ResponseRecord[];
  isAnonymous: boolean;
  /** How many to show before offering the rest. `null` shows all of them. */
  limit: number | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (summary.answers.length === 0) {
    return <p className="text-xs text-muted-foreground">Nobody has answered this one.</p>;
  }

  const shown =
    limit === null || expanded ? summary.answers : summary.answers.slice(0, limit);

  return (
    <>
      <ul className="flex flex-col gap-2">
        {shown.map((answer) => {
          const response = responses[answer.responseIndex];

          return (
            <li
              key={`${answer.responseIndex}-${summary.column.key}`}
              className="rounded-lg border bg-muted px-2.5 py-2 text-xs leading-relaxed"
            >
              {answer.text}
              {response ? (
                <span className="mt-1.5 block text-2xs text-muted-foreground">
                  {isAnonymous
                    ? formatDateTime(response.submitted_at)
                    : `${response.submitter_name ?? "Outside your department"} · ${formatDateTime(response.submitted_at)}`}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {limit !== null && !expanded && summary.answers.length > limit ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setExpanded(true)}
        >
          See all {summary.answers.length}
        </Button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// QUESTION
// ---------------------------------------------------------------------------

/**
 * One question at a time, with every answer in full.
 *
 * The Summary tab shows three free-text answers and a "See all"; this is where
 * somebody goes to read them properly. A choice question gets its bars here too
 * rather than an empty panel — the answer to "show me this question" is the
 * whole of what is known about it.
 */
function QuestionView({
  responses,
  summaries,
  isAnonymous,
}: {
  responses: ResponseRecord[];
  summaries: QuestionSummary[];
  isAnonymous: boolean;
}) {
  const [key, setKey] = useState<string | null>(summaries[0]?.column.key ?? null);

  if (summaries.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="No questions"
        description="This form has no questions yet, so there is nothing to break down."
      />
    );
  }

  const chosen = summaries.find((summary) => summary.column.key === key) ?? summaries[0]!;

  // `items` is what makes the trigger show the question rather than the raw
  // field key — the thing `check:select-items` exists to fail.
  const items = Object.fromEntries(
    summaries.map((summary, index) => [summary.column.key, `${index + 1}. ${summary.column.label}`]),
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="response-question">Question</Label>
        <Select items={items} value={chosen.column.key} onValueChange={setKey}>
          <SelectTrigger id="response-question" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {summaries.map((summary, index) => (
              <SelectItem key={summary.column.key} value={summary.column.key}>
                {index + 1}. {summary.column.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <section className="rounded-lg border px-4 py-3.5">
        <QuestionHeading summary={chosen} />

        {chosen.kind === "choice" ? <ChoiceBars summary={chosen} /> : null}
        {chosen.kind === "date" ? <DateSpan summary={chosen} /> : null}
        {chosen.kind === "text" ? (
          // No limit here: reading them all is the reason this view exists.
          <TextAnswers
            summary={chosen}
            responses={responses}
            isAnonymous={isAnonymous}
            limit={null}
          />
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// INDIVIDUAL
// ---------------------------------------------------------------------------

/**
 * One person's whole submission.
 *
 * ⚠️ NEVER RENDERED ON AN ANONYMOUS FORM — see the note at the top of this file.
 * It is not reachable from the tab strip there, and it would have nothing to
 * show if it were.
 *
 * ⚠️ THE ORDER IS THE QUERY'S, NEWEST FIRST, and "1 of 12" counts in that order.
 * It is the same order the Summary's answers appear in, so moving between the
 * two does not silently reshuffle who is who.
 */
function IndividualView({
  responses,
  summaries,
}: {
  responses: ResponseRecord[];
  summaries: QuestionSummary[];
}) {
  const [at, setAt] = useState(0);

  // Clamped rather than trusted: the array is a prop and can shrink under this
  // state on a refresh.
  const index = Math.min(at, responses.length - 1);
  const response = responses[index];

  if (!response) {
    return <EmptyState icon={<Inbox />} title="No answers yet" description="Nobody has filled this form in." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={index === 0}
          onClick={() => setAt(index - 1)}
        >
          <ChevronLeft />
          Previous
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {index + 1} of {responses.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={index >= responses.length - 1}
          onClick={() => setAt(index + 1)}
        >
          Next
          <ChevronRight />
        </Button>
      </div>

      <div className="flex items-center gap-2.5 border-t pt-3">
        {response.submitter_name && response.submitted_by ? (
          <Monogram id={response.submitted_by} name={response.submitter_name} />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {/*
              Never the UUID (§6: no table name, no enum, no id in front of a
              person) and never a blank, which reads as "nobody". The response
              policy is scoped by the FORM's department and the user policies by
              the READER's, so a company-wide survey legitimately collects
              answers whose authors this reader cannot look up.
            */}
            {response.submitter_name ?? "Outside your department"}
          </p>
          <p className="text-xs text-muted-foreground">
            Answered {formatDateTime(response.submitted_at)}
          </p>
        </div>
      </div>

      <dl className="space-y-0">
        {summaries.map((summary, position) => {
          const answer = answerFor(response.field_values, summary.column.key);

          return (
            <div key={summary.column.key} className="border-t py-2.5">
              <dt className="text-xs text-muted-foreground">
                {position + 1}. {summary.column.label}
              </dt>
              <dd className="mt-0.5 text-sm">
                {answer === null ? (
                  <span className="text-foreground-faint">
                    <span aria-hidden>—</span>
                    <span className="sr-only">Not answered</span>
                  </span>
                ) : (
                  answer
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

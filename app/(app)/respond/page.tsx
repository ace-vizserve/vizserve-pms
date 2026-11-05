import type { Metadata } from "next";
import Link from "next/link";
import { AlarmClock, ArrowRight, CheckCircle2, FilePenLine, Inbox } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { StatTile } from "@/components/stat-tile";
import { Chip } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { requireAuthContext } from "@/lib/auth/authorization";
import { daysBetween, formatDate, relativeDays, todayInAppZone } from "@/lib/dates";
import { loadDepartmentNames } from "@/lib/departments-server";
import { isDisplayOnly } from "@/lib/form-builder/canvas";
import { isFormClosed, readFormDeadlines } from "@/lib/form-builder/deadline";
import { formToAnswerSchema } from "@/lib/schemas/sidebar";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = { title: "To answer" };

/**
 * P7-66 Phase 4b — WHAT THERE IS TO ANSWER.
 *
 * `/forms` is the BUILDER and is a team leader's screen. This is the other end
 * of the same table: the published internal forms anybody signed in
 * may fill in, which is why it and the builder are To answer and Manage under one
 * Surveys & Quizzes row (lib/navigation.ts).
 *
 * ⚠️ MEMBER-LEVEL, AND THAT IS THE POINT — `requireAuthContext()`, not
 * `requireRole`. Everyone in the company answers a pulse survey.
 *
 * ⚠️ NO CLIENT FORM APPEARS HERE, and it is RLS that guarantees it rather than
 * the two `.eq()`s below. `published internal forms readable by their audience`
 * (20260902110000_p7_66_form_responses.sql) is the ONLY policy that shows a
 * form row to a member, and it is already `purpose = 'INTERNAL' and
 * is_active`. The filters are here because a TEAM LEADER also has the
 * department-scoped policies and would otherwise see their own client forms
 * listed as things to fill in — a different question from "may they read it".
 * That is a narrowing of what this SCREEN is about, not a restatement of a
 * department policy.
 */
export default async function RespondPage() {
  await requireAuthContext();
  const supabase = await createClient();

  const { data: forms, error } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name, slug, description, is_anonymous, is_quiz, department_id, first_published_at, schema")
    .eq("purpose", "INTERNAL")
    .eq("is_active", true)
    .order("name");

  // "This did not load" is a different sentence from "there is nothing to fill
  // in", and the empty state below is written to be reassuring — so a failed
  // read must never be allowed to wear it.
  if (error) {
    return (
      <PageShell>
        <QueryError what="the forms you can fill in" message={error.message} />
      </PageShell>
    );
  }

  /*
   * P17-10. Both reads are allowed to fail: the list is still the list without a
   * deadline or a "To answer" pill, and neither exists until the migration is
   * pasted. A closed form has nothing left to do, so it leaves the list.
   */
  const [deadlines, awaiting, departmentNames] = await Promise.all([
    readFormDeadlines(supabase, (forms ?? []).map((form) => form.id)),
    supabase.rpc("vizserve_pms_forms_awaiting_me"),
    loadDepartmentNames(),
  ]);
  const today = todayInAppZone();

  const waitingIds = awaiting.error
    ? null
    : new Set((formToAnswerSchema.array().safeParse(awaiting.data).data ?? []).map((form) => form.id));

  const rows = (forms ?? [])
    .map((form) => ({
      id: form.id,
      name: form.name,
      slug: form.slug,
      description: form.description,
      is_anonymous: form.is_anonymous,
      closesOn: deadlines?.get(form.id) ?? null,
      questions: questionCount(form.schema),
      kind: form.is_quiz ? "Quiz" : "Survey",
      department: form.department_id ? (departmentNames.get(form.department_id) ?? null) : null,
      sentOn: form.first_published_at,
    }))
    .filter((form) => !isFormClosed(form.closesOn));

  // Soonest deadline first, because that is the order to answer them in. Names otherwise.
  const waiting = rows
    .filter((form) => waitingIds?.has(form.id))
    .sort((a, b) => (a.closesOn ?? "9999").localeCompare(b.closesOn ?? "9999"));
  const closingSoon = waiting.filter((form) => isClosingSoon(form.closesOn, today, 7)).length;
  const rest = rows.filter((form) => !waitingIds?.has(form.id));

  /*
   * ⚠️ NOT WAITING DOES NOT MEAN ANSWERED. A lead can read a form aimed at other
   * departments, and a form can have no questions yet; calling those "answered" would
   * be false. So each is asked, and only when the waiting list actually loaded.
   */
  const answeredFlags = waitingIds
    ? await Promise.all(
        rest.map((form) => supabase.rpc("vizserve_pms_i_answered_form", { p_form_id: form.id })),
      )
    : [];
  const answered = rest.filter((_, index) => answeredFlags[index]?.data === true);
  const other = rest.filter((_, index) => answeredFlags[index]?.data !== true);

  return (
    <PageShell>
      {rows.length === 0 ? (
        <EmptyState
          icon={<FilePenLine />}
          title="Nothing to answer"
          description="Surveys and quizzes sent to you appear here, and you get an email when one goes live."
        />
      ) : waitingIds === null ? (
        // The waiting list did not load, so no form can honestly be sorted into a section.
        <FormPanel title="Forms" count={rows.length}>
          {rows.map((form) => (
            <FormRow key={form.id} form={form} state="other" today={today} />
          ))}
        </FormPanel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile compact label="Waiting on you" value={waiting.length} icon={<Inbox />} tone={waiting.length > 0 ? "info" : "neutral"} />
            <StatTile
              compact
              label="Closing this week"
              value={closingSoon}
              icon={<AlarmClock />}
              tone={closingSoon > 0 ? "warning" : "neutral"}
            />
            <StatTile compact label="Answered" value={answered.length} icon={<CheckCircle2 />} tone="success" />
          </div>

          <FormPanel title="Waiting on you" count={waiting.length}>
            {waiting.length > 0 ? (
              waiting.map((form) => <FormRow key={form.id} form={form} state="waiting" today={today} />)
            ) : (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                You are all caught up. Nothing is waiting on you.
              </li>
            )}
          </FormPanel>

          {answered.length > 0 ? (
            <FormPanel title="Already answered" count={answered.length}>
              {answered.map((form) => (
                <FormRow key={form.id} form={form} state="answered" today={today} />
              ))}
            </FormPanel>
          ) : null}

          {other.length > 0 ? (
            <FormPanel title="Other forms" count={other.length}>
              {other.map((form) => (
                <FormRow key={form.id} form={form} state="other" today={today} />
              ))}
            </FormPanel>
          ) : null}
        </>
      )}
    </PageShell>
  );
}

function isClosingSoon(closesOn: string | null, today: string, withinDays: number): boolean {
  if (!closesOn) return false;
  const left = daysBetween(today, closesOn);

  return left !== null && left <= withinDays;
}

/** For a line of text only, so the raw document is read rather than parsed for every form. */
function questionCount(schema: unknown): number {
  const { root = [], entities = {} } = (schema ?? {}) as {
    root?: string[];
    entities?: Record<string, { type: string; attributes?: { archived?: boolean } }>;
  };

  return root.filter((id) => {
    const entity = Object.hasOwn(entities, id) ? entities[id] : undefined;

    return entity !== undefined && entity.attributes?.archived !== true && !isDisplayOnly(entity.type);
  }).length;
}

function FormPanel({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card grade-surface shadow-raised-lg">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold tracking-[-0.014em]">
        {title}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
      </h2>
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

type FormRowData = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_anonymous: boolean;
  closesOn: string | null;
  questions: number;
  kind: string;
  department: string | null;
  sentOn: string | null;
};

/**
 * Rows, not cards: with a form or two on the page, a grid of cards left one small box and
 * a screen of nothing. An answered form is not a link, because each person answers once
 * and all it could open is a page saying so.
 */
function FormRow({
  form,
  state,
  today,
}: {
  form: FormRowData;
  state: "waiting" | "answered" | "other";
  today: string;
}) {
  const answered = state === "answered";
  // Three days is when a deadline turns into a chip; further out it is just a fact.
  const urgent = !answered && isClosingSoon(form.closesOn, today, 3);
  const meta = [
    form.kind,
    form.department,
    form.questions > 0 ? `${form.questions} ${form.questions === 1 ? "question" : "questions"}` : null,
    form.is_anonymous ? "Anonymous" : null,
    form.sentOn ? `Sent ${formatDate(form.sentOn)}` : null,
    form.closesOn && !answered && !urgent ? `Closes ${formatDate(form.closesOn)}` : null,
  ].filter(Boolean);
  const deadlineChip = urgent ? (
    <Chip tone="warning" label={`Closes ${relativeDays(form.closesOn)}`} className="shrink-0" />
  ) : null;

  const body = (
    <>
      <span
        aria-hidden
        className={
          answered
            ? "flex size-8 shrink-0 items-center justify-center rounded-md border border-success-border bg-success-subtle text-success"
            : "flex size-8 shrink-0 items-center justify-center rounded-md border border-accent-border bg-accent text-accent-foreground"
        }
      >
        {answered ? <CheckCircle2 className="size-4" /> : <FilePenLine className="size-4" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold tracking-[-0.014em]">{form.name}</span>
        {form.description ? (
          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
            {form.description}
          </span>
        ) : null}
        {meta.length > 0 ? (
          <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">{meta.join(" · ")}</span>
        ) : null}
      </span>
    </>
  );

  if (answered) {
    return (
      <li className="flex items-center gap-3 px-4 py-3.5">
        {body}
        <Chip tone="success" label="Answered" className="shrink-0" />
      </li>
    );
  }

  return (
    <li>
      {/* The whole row is the link. The "button" is a span, so it is one tab stop. */}
      <Link
        href={`/respond/${form.slug}`}
        className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent"
      >
        {body}
        {deadlineChip}
        <span
          className={buttonVariants({
            size: "sm",
            variant: state === "waiting" ? "default" : "outline",
            className: "hidden shrink-0 sm:inline-flex",
          })}
        >
          {state === "waiting" ? "Answer" : "Open"}
        </span>
        <ArrowRight aria-hidden className="size-4 shrink-0 text-foreground-faint sm:hidden" />
      </Link>
    </li>
  );
}

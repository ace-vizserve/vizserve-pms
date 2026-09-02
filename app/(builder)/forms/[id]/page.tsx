import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { Chip } from "@/components/status-badge";
import { QueryError } from "@/components/query-error";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ClientFormSettings } from "@/app/(app)/forms/form-settings";
import { EngagementSettings } from "@/app/(app)/forms/engagement-settings";
import {
  optionsFromRow,
  reconcileFormSchema,
  type FormFieldRow,
} from "@/lib/form-builder/schema";
import type { FieldType } from "@/lib/schemas/forms";
import { FieldBuilder } from "./field-builder";
import { FormResponses } from "./responses";
import { BuilderTabs } from "./builder-tabs";
// ⚠️ NOT from "./builder-tabs" — that module is `"use client"`, and calling a
// pure export of a client module from a server component is a runtime crash
// typecheck cannot see. See the note in ./tabs.ts.
import { builderTabsFor, resolveBuilderTab } from "./tabs";
import { BuilderTitle } from "./builder-title";
import { SaveStatusLine, SaveStatusProvider } from "./save-status";
import { administersForm } from "@/app/(app)/forms/administers";
import { countFormSubmissions } from "@/app/(app)/forms/submission-count";
import { loadRoutableDepartments } from "@/app/(app)/forms/routable-departments";

export const metadata: Metadata = { title: "Edit form" };

/**
 * P7-66 Phase 4a — THE BUILDER'S OWN CHROME.
 *
 * This route left the `(app)` shell (see `app/(builder)/layout.tsx`), so the
 * sidebar, the breadcrumb and the theme toggle it used to sit inside are gone.
 * The same three jobs still have to be done, and this bar does them: say which
 * form you are in, give one obvious way back to the list, and keep the theme
 * switch reachable.
 *
 * Same object as the shell's top bar and `app/page.tsx`'s: 56px, frosted
 * `bg-panel` behind a blur with `shadow-chrome` and a hairline, sticky — so the
 * canvas visibly passes UNDER it and the way out never scrolls away from a form
 * with thirty questions on it.
 *
 * Full-bleed `px-5`, matching `PageShell`, so the bar and the content share a
 * left edge.
 */
function BuilderHeader({
  title,
  children,
}: {
  /**
   * The page's `<h1>`.
   *
   * A NODE rather than a string, because on the loaded page it is an editable
   * input (`BuilderTitle`) and on a failed read it is plain text — there is
   * nothing to edit when the form did not arrive, and offering a box that saves
   * a name onto a form nobody could read is worse than offering nothing.
   */
  title?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-panel px-5 shadow-chrome backdrop-blur-md backdrop-saturate-150">
      <Link
        href="/forms"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        <ArrowLeft />
        Forms
      </Link>

      <Separator
        orientation="vertical"
        className="data-vertical:h-4 data-vertical:self-auto"
      />

      {title ?? (
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">Edit form</h1>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {children}
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * ⚠️ THE BUILDER IS NOT RENDERED ON A FAILED READ, and this is the shape of
 * that refusal.
 *
 * `QueryError` everywhere else in the app separates "this did not load" from
 * "there is nothing here" so that an empty screen cannot talk somebody out of
 * reporting a fault. Here it does something stronger: it is the only thing
 * standing between a dropped query and DATA LOSS. See the note on the fields
 * read below.
 *
 * The name is passed when it is known, so the header still says which form
 * failed rather than falling back to the generic title. (It used to name the
 * page in the shell breadcrumb; there is no breadcrumb on this route any more,
 * so the same value goes to the header this route carries instead.)
 */
function FormLoadFailure({
  formName,
  what,
  message,
}: {
  formName?: string;
  what: string;
  message?: string;
}) {
  return (
    <>
      <BuilderHeader
        title={
          formName === undefined ? undefined : (
            <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{formName}</h1>
          )
        }
      />
      <div className="mx-auto w-full max-w-3xl p-5">
        <QueryError what={what} message={message} />
      </div>
    </>
  );
}

export default async function EditFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /*
   * ⚠️ ONLY `?tab=`. The Responses panel used to be PAGED and carried
   * `?page=`/`?size=`; it is now a count and a list of who answered, which has
   * nothing to page. `?tab=` survives because a link to the answers has to open
   * on the answers — and it is narrowed against the tabs THIS form offers, since
   * a client form no longer has a Responses tab at all.
   */
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const context = await requireRole("team_leader");
  const supabase = await createClient();

  // RLS decides visibility, so an out-of-scope id simply returns nothing —
  // which is a 404 to the caller rather than a "forbidden" that confirms the
  // form exists.
  //
  // ⚠️ P7-66 Phase 4b — RLS IS NO LONGER SUFFICIENT ON ITS OWN HERE, and
  // `administersForm` below is why. `created_by` is selected for it.
  const { data: form, error: formError } = await supabase
    .from("vizserve_pms_forms")
    .select(
      "id, name, slug, description, department_id, created_by, reference_prefix, purpose, is_anonymous, is_public, is_active, requires_attachment, sla_minutes, default_list_id, client_approval_days, schema",
    )
    .eq("id", id)
    .maybeSingle();

  // Told apart, rather than both becoming `notFound()`. "No such form" and "the
  // query died" are different sentences, and only one of them is worth
  // reporting to support.
  if (formError) return <FormLoadFailure what="this form" message={formError.message} />;

  if (!form) notFound();

  /*
   * ⚠️ P7-66 Phase 4b — THE READ THAT LET A MEMBER FILL A FORM IN ALSO LET A
   * LEAD OPEN SOMEBODY ELSE'S.
   *
   * `published engagement forms readable by staff`
   * (20260902110000_p7_66_form_responses.sql) is company-wide by necessity: a
   * member cannot answer a survey they cannot read. Policies are OR'd, so after
   * it the read above succeeds for a lead of ANOTHER department — and this page
   * would render that form's entire question schema in an editor, with a Save
   * button that Postgres then refuses.
   *
   * The row is legitimately readable by them; it is not theirs to ADMINISTER,
   * and no row-level policy can express that difference. `notFound()` rather
   * than a forbidden page, matching the line above: a caller guessing ids
   * learns nothing about which of the two it was. The Responses table below is
   * scoped separately and more tightly still, by its own policy.
   */
  if (!administersForm(context, form)) notFound();

  /*
   * ⚠️ `created_at` IS LOAD-BEARING, NOT PADDING, and `FormFieldRow` requires it
   * so that this select cannot quietly lose it. The projection orders
   * `sort_order, created_at, id` because the migration's backfill does, and live
   * forms share `sort_order` values — drop the column and tied fields would be
   * ordered differently here than by the SQL twin, on the oldest forms and
   * silently.
   */
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("vizserve_pms_form_fields")
    .select(
      "id, label, field_key, field_type, help_text, options, is_required, is_active, sort_order, created_at",
    )
    .eq("form_id", id)
    .order("sort_order");

  // P2-06 — scoped by RLS to the departments this person leads.
  const { data: lists, error: listsError } = await supabase
    .from("vizserve_pms_lists")
    .select("id, name, department_id, form_id")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");

  /*
   * ⚠️ P7-66 Phase 4b — RESPONSES COUNT TOWARDS `hasSubmissions` TOO, and this
   * is the SCREEN's half of the fix the purpose lock makes on the server. An
   * engagement form never produces a request, so counting requests alone left
   * the purpose and prefix inputs looking unlocked on a form with a thousand
   * answers behind it — the action would refuse the save, but only after
   * somebody had typed the change.
   *
   * ⚠️ AND IT IS THE SAME FUNCTION THE ACTION CALLS, deliberately, rather than
   * a second pair of queries that agrees with it today. Which means it inherits
   * two properties that matter more than the sharing:
   *
   *   IT COUNTS AS THE SERVICE ROLE. Both count policies are
   *   `manages_department(form.department_id)`, FALSE for a team leader on an
   *   UNROUTED form — a form `administersForm` above has just confirmed is
   *   theirs to edit. Read as the caller, the counts came back zero AND NO
   *   ERROR (CLAUDE.md: a failing policy returns zero rows), so the two locked
   *   inputs rendered unlocked. Authority is settled by `requireRole` and
   *   `administersForm`; how many answers exist is a data question.
   *
   *   IT FAILS CLOSED. A count that errors is not a count of zero, and the
   *   failure joins `readFailure` below rather than unlocking the inputs.
   *
   * ⚠️ RESPONSES ARE ONLY COUNTED ON AN ENGAGEMENT FORM, and that is deliberate
   * rather than an optimisation. A CLIENT_REQUEST form cannot have a response —
   * the INSERT policy checks the purpose — so the count is known to be zero
   * without asking. Which means 20260902110000_p7_66_form_responses.sql being
   * unapplied cannot break the builder for the four live client forms: they
   * never issue the query. `updateFormSettings` passes no such flag, because
   * the lock itself must never assume which kind of form it is looking at.
   */
  const isEngagement = form.purpose === "EMPLOYEE_ENGAGEMENT";

  const counted = await countFormSubmissions(id, { includeResponses: isEngagement });

  const countError = counted.ok ? null : { message: counted.message };
  const submissionCount = counted.ok ? counted.total : 0;

  /*
   * ⚠️ A TEAM LEADER WHO LEADS NOTHING IS NOT A FAILED READ.
   *
   * This used to narrow with `.in("id", [""])`, and `""` is not a uuid — the
   * query ALWAYS came back `invalid input syntax for type uuid: ""` (22P02) for
   * that person. Harmless while the error was discarded; a hard page failure the
   * moment `departmentsError` joined the group below, because the state is
   * reachable: a newly created team leader with no department mapping can create
   * an unrouted form (`department_id is null`) and read it back through "forms
   * readable by author while unrouted", so `notFound()` does not fire and the
   * builder is replaced by `FormLoadFailure` on every load.
   *
   * `loadRoutableDepartments` answers that with an empty list and no round trip,
   * and keeps a genuine failure in `error`. See the note there.
   */
  const { departments, error: departmentsError } = await loadRoutableDepartments(
    supabase,
    context,
  );

  /*
   * ⚠️ A FAILED FIELDS READ MUST NOT OPEN THE BUILDER. THIS IS THE DESTRUCTIVE
   * ONE.
   *
   * `error` used to be discarded here and the rows read as `fieldRows ?? []`, so
   * a dropped connection looked exactly like a form with no fields.
   * `reconcileFormSchema` would then find the rows and the stored blob
   * disagreeing, decide — correctly, by its own rule — that the rows win, and
   * hand the builder an EMPTY schema. The next save projects that empty schema
   * back through `vizserve_pms_save_form_schema`, whose step 2 deletes every
   * field row no request answers. One transient failure, and a form's fields are
   * gone. That is the precise outcome the reconcile comment below claims to
   * prevent, committed by the read that feeds it.
   *
   * `vizserve_pms_form_field_protect` still refuses to drop a field that HAS
   * answers, so the damage stops at the fields nobody has filled in yet — which
   * on the four live forms, all of which have zero field rows and zero stored
   * answers, is all of them.
   *
   * The rest are grouped with it rather than tolerated separately:
   *   - `submissionCount` decides `hasSubmissions`, which is what stops a slug
   *     or a reference prefix being changed under live requests. A dropped count
   *     reads as zero and unlocks it.
   *   - `lists` and `departments` fill two `<Select>`s in the settings card. An
   *     empty one is a form whose owning department appears unset, and saving
   *     that screen writes what it shows. Note this catches a FAILURE only: an
   *     empty `departments` with no error is a team leader who leads nothing,
   *     which is a real answer and renders the picker empty as it always did.
   *
   * Every one of them turns a read failure into a WRITE, which is why none of
   * them is allowed to reach the render.
   */
  const readFailure = fieldsError ?? countError ?? listsError ?? departmentsError;

  if (readFailure) {
    return (
      <FormLoadFailure
        formName={form.name}
        what="this form's fields and settings"
        message={readFailure.message}
      />
    );
  }

  /*
   * `options` is `Json` on the row type and `string[]` in the projection.
   *
   * ⚠️ NOT NARROWED — REFUSED. This used to filter the non-strings out, which
   * looked like a display-time courtesy and was not: the filtered list is the
   * schema the builder edits and the next save writes back over the row, so the
   * hidden entries would have been permanently dropped from the stored choices.
   * See `optionsFromRow`. The column's own CHECK makes this unreachable through
   * the app, so refusing costs nothing and losing a choice would be silent.
   */
  const fields: FormFieldRow[] = [];
  let unreadableField: string | null = null;

  for (const row of fieldRows ?? []) {
    const options = optionsFromRow(row.options);

    if (options === null) {
      unreadableField = row.field_key;
      break;
    }

    fields.push({
      id: row.id,
      label: row.label,
      field_key: row.field_key,
      field_type: row.field_type as FieldType,
      help_text: row.help_text,
      options,
      is_required: row.is_required,
      is_active: row.is_active,
      sort_order: row.sort_order,
      created_at: row.created_at,
    });
  }

  if (unreadableField !== null) {
    return (
      <FormLoadFailure
        formName={form.name}
        what="this form's fields"
        message={`The field "${unreadableField}" has an option list this builder cannot open without rewriting it.`}
      />
    );
  }

  /*
   * ⚠️ P7-66 Phase 2 — THE BLOB IS RECONCILED AGAINST THE ROWS BEFORE IT IS
   * TRUSTED, and the rows win.
   *
   * Phase 1's dual-write logged and swallowed a failed blob write on the
   * argument that the next save re-derives it. That does not cover the last save
   * before a form is published and left alone — and that form's stale blob,
   * opened here and saved back, would have
   * `vizserve_pms_save_form_schema` project it over the rows and DELETE every
   * field it omits. So the builder opens on what the rows say.
   *
   * Which is only true because the read above is now checked: "the rows say
   * nothing" and "the rows did not arrive" are the same value to this function.
   *
   * The disagreement is logged rather than merely repaired: a stale blob is a
   * Phase 1 write that never landed, and it is worth knowing it happened.
   */
  const { schema: initialSchema, storedWasCurrent } = reconcileFormSchema(form.schema, fields);

  if (!storedWasCurrent) {
    console.warn("[P7-66] stored form schema disagreed with the rows; using the rows", {
      formId: form.id,
    });
  }

  return (
    /*
     * FULL-BLEED, AND NO `PageShell`.
     *
     * The page used to be capped at `max-w-5xl` inside the 304px sidebar. The
     * builder puts a sort rail beside the form, and an app sidebar beside THAT
     * is a second rail competing for the same edge of the screen — which is why
     * this route moved out of the shell entirely
     * (`app/(builder)/layout.tsx`). What is left is the builder and nothing
     * else, so it gets the whole window.
     *
     * Full-bleed is not unbounded: `FieldBuilder` caps the FORM column, so a
     * question never stretches across an ultrawide monitor while the rail stays
     * pinned to the edge where the eye expects a tool rail.
     */
    <SaveStatusProvider>
      <BuilderHeader
        title={
          <div className="flex min-w-0 flex-col justify-center">
            <BuilderTitle formId={form.id} name={form.name} />
            {/* Directly under the name, where a Save button used to be — this
                is what replaced it. See `save-status.tsx`. */}
            <span className="pl-1.5">
              <SaveStatusLine />
            </span>
          </div>
        }
      >
        {form.is_active ? (
          <Chip tone="success" label="Live" />
        ) : (
          <Chip tone="neutral" label="Draft" />
        )}
        {/*
          P7-66 Phase 4b — THE LINK GOES WHERE THE FORM ACTUALLY LIVES.

          A client form's face is /request/<slug>, with no session, and the label
          says "public" because that is the thing worth knowing before you paste
          it into an email. An engagement form's face is /respond/<slug>, which
          needs a session and is where colleagues fill it in — a different URL,
          a different audience, and calling it "public" would be exactly the
          wrong thing to tell somebody about a staff survey.

          `is_public` rather than `purpose` on the client branch, because that
          boolean is what /request/<slug> actually filters on. The CHECK ties
          the two, so they cannot disagree; each side is written in the terms
          its own route reads.
        */}
        {form.is_active && isEngagement ? (
          <Link
            href={`/respond/${form.slug}`}
            target="_blank"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Open the staff form
            <ExternalLink />
          </Link>
        ) : null}
        {form.is_active && form.is_public ? (
          <Link
            href={`/request/${form.slug}`}
            target="_blank"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            View public form
            <ExternalLink />
          </Link>
        ) : null}
      </BuilderHeader>

      <BuilderTabs
        initialTab={resolveBuilderTab(rawTab, builderTabsFor(form.purpose))}
        responsesCount={submissionCount}
        questions={
          <div className="flex flex-col gap-4 p-5">
            {/*
              ONE SENTENCE NOW, BECAUSE THE GUARANTEE IS THE SAME ON BOTH.

              This used to say two different things. `vizserve_pms_form_field_protect`
              refuses a key rename or a field delete once the form has submissions,
              but it counted `vizserve_pms_requests` and nothing else — and an
              engagement form never produces one. So on a staff survey the lock did
              not fire, and the honest sentence there was a WARNING that renaming a
              question orphans its answers, not a promise that it cannot happen.

              20260902110000_p7_66_form_responses.sql closes that: the guard now
              asks both tables, so a key with an answer under it is immutable
              whichever kind of form it belongs to. The screen can make the promise
              again, in one sentence, because Postgres is now making it.

              Only the NOUN still differs — an engagement form collects answers and
              a client form collects submissions, and calling a colleague's survey
              answer a "submission" is the kind of small wrongness that makes a
              screen feel like it was built for something else.
            */}
            {submissionCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {submissionCount} {isEngagement ? "answer" : "submission"}
                {submissionCount === 1 ? "" : "s"} — field keys are locked.
              </p>
            ) : null}

            <FieldBuilder
              formId={form.id}
              purpose={form.purpose}
              isAnonymous={form.is_anonymous}
              formName={form.name}
              description={form.description}
              hasSubmissions={submissionCount > 0}
              initialSchema={initialSchema}
            />
          </div>
        }
        responses={
          /*
            ⚠️ P7-66 Phase 4 — NO PANEL AT ALL ON A CLIENT FORM, WHICH REMOVES
            THE TAB RATHER THAN EMPTYING IT.

            This used to render a second panel here, listing the requests the
            form had minted. It was a second door onto /requests that showed
            less: no filters, no SLA clock, no Gate 1 decision, eight rows and a
            link. /requests is the ONE place requests are read, and a more
            convenient screen that tells you less is how a queue stops being the
            queue.

            An engagement form is the opposite case — its answers have no other
            screen — so the tab on the form IS where they are read.
          */
          isEngagement ? (
            <FormResponses
              formId={form.id}
              departmentId={form.department_id}
              isAnonymous={form.is_anonymous}
            />
          ) : undefined
        }
        settings={
          /*
            ⚠️ P7-66 Phase 4 — TWO CARDS, NOT ONE CARD BRANCHING ON ITSELF.

            This was `FormSettings` with `isClientRequest` deciding which of
            eleven controls to draw. A client form and an engagement form are
            different products, and a screen that renders one as the other with
            six fields missing is exactly what blurred them: the ROUTING
            department and the OWNING department are the same column meaning two
            different things, and one card cannot say both.

            Splitting also removes the purpose picker, which is the point rather
            than a side effect. `purpose` is now a CONSTANT inside each card —
            the field whose stray default once put a published staff form on the
            public internet cannot be sent wrongly by a screen that only knows
            one value.
          */
          <div className="mx-auto w-full max-w-3xl p-5">
            {isEngagement ? (
              <EngagementSettings
                departments={departments}
                formId={form.id}
                hasSubmissions={submissionCount > 0}
                initial={{
                  name: form.name,
                  description: form.description,
                  department_id: form.department_id,
                  is_anonymous: form.is_anonymous,
                  is_active: form.is_active,
                  /*
                    The five the card never draws, loaded so its save resends
                    what is stored rather than a value `formSettingsSchema` —
                    which defaults nothing, deliberately — would reject or
                    overwrite. See the note there.
                  */
                  slug: form.slug,
                  reference_prefix: form.reference_prefix,
                  requires_attachment: form.requires_attachment,
                  sla_minutes: form.sla_minutes,
                  default_list_id: form.default_list_id,
                  client_approval_days: form.client_approval_days,
                }}
              />
            ) : (
              <ClientFormSettings
                departments={departments}
                lists={lists ?? []}
                formId={form.id}
                hasSubmissions={submissionCount > 0}
                initial={{
                  name: form.name,
                  slug: form.slug,
                  description: form.description,
                  department_id: form.department_id,
                  reference_prefix: form.reference_prefix,
                  is_active: form.is_active,
                  requires_attachment: form.requires_attachment,
                  sla_minutes: form.sla_minutes,
                  default_list_id: form.default_list_id,
                  client_approval_days: form.client_approval_days,
                }}
              />
            )}
          </div>
        }
      />
    </SaveStatusProvider>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Globe, Users } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import {
  FORM_PURPOSES,
  FORM_PURPOSE_LABELS,
  type FormPurpose,
} from "@/lib/schemas/forms";
import { ClientFormSettings } from "../form-settings";
import { loadRoutableDepartments, type RoutableDepartment } from "../routable-departments";
import { EngagementCreate } from "./engagement-create";

export const metadata: Metadata = { title: "New form" };

/** The crumb back to the list, shared by all three states of this page. */
function BackToForms() {
  return (
    <Link
      href="/forms"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      Forms
    </Link>
  );
}

/**
 * P7-66 — THE CHOICE IS IN THE URL, NOT IN A useState.
 *
 * `/forms/new` is the chooser, `/forms/new?purpose=CLIENT_REQUEST` is today's
 * settings card, `/forms/new?purpose=EMPLOYEE_ENGAGEMENT` is the one-box flow.
 * Three addressable states rather than one component switching on itself, which
 * buys the browser Back button working the way somebody who picked wrong
 * expects, a bookmarkable "new engagement form", and — the reason it is worth
 * writing down — no client state at all on a page that is otherwise entirely
 * server-rendered.
 *
 * Anything else in `?purpose` falls through to the chooser rather than erroring.
 * A hand-typed query string is not an incident.
 */
function parsePurpose(raw: string | string[] | undefined): FormPurpose | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return FORM_PURPOSES.find((purpose) => purpose === value) ?? null;
}

const PURPOSE_ICON = { CLIENT_REQUEST: Globe, EMPLOYEE_ENGAGEMENT: Users } as const;

/**
 * The one decision this page makes for an engagement form.
 *
 * ⚠️ DERIVED, NOT ASKED, AND THE JUSTIFICATION IS THE WHOLE POINT OF THE FLOW.
 * "Name it and start writing questions" survives exactly one extra required
 * field, and a department picker is not the one worth spending it on: it is the
 * least interesting question on the settings card, it is the one the app can
 * usually answer itself, and it is the only one that can be changed later with
 * no consequence at all — unlike the slug, which becomes an address, or the
 * prefix, which locks.
 *
 * So the rule is: the creator's PRIMARY department if they can actually route
 * to it, otherwise the only department they lead if there is exactly one,
 * otherwise null.
 *
 * ⚠️ MEMBERSHIP IN THE ROUTABLE LIST IS THE TEST, NOT `canAccessDepartment`,
 * and the difference matters. `primaryDepartmentId` is where somebody WORKS;
 * `vizserve_pms_user_managed_departments` is what they LEAD (D15), and a team
 * leader can perfectly well sit in VizMedia while leading VizBytes. Inserting
 * their primary department blind would be refused by the `forms insertable by
 * team leaders` policy's `with check` — a create that fails on a field the
 * person was never shown. The routable list is already narrowed by
 * `departmentPickerScope`, so a hit in it is a value RLS will accept AND a
 * value the settings `<Select>` can display; testing anything else can produce
 * an id that is legal to insert but renders as an empty picker.
 *
 * Null is a real answer, not a failure: `forms readable by author while
 * unrouted` keeps the draft visible to its creator, and
 * `vizserve_pms_forms_active_requires_department` stops it being published
 * until somebody picks. `EngagementCreate` says so on screen rather than
 * leaving it to be discovered at the Publish switch.
 */
function defaultDepartmentId(
  primaryDepartmentId: string | null,
  departments: RoutableDepartment[],
): string | null {
  if (primaryDepartmentId && departments.some((d) => d.id === primaryDepartmentId)) {
    return primaryDepartmentId;
  }

  return departments.length === 1 ? departments[0].id : null;
}

export default async function NewFormPage({
  searchParams,
}: {
  searchParams: Promise<{ purpose?: string | string[] }>;
}) {
  const context = await requireRole("team_leader");
  const purpose = parsePurpose((await searchParams).purpose);

  // The chooser needs no data at all, so it does not pay for any.
  if (purpose === null) {
    return (
      <PageShell className="mx-auto w-full max-w-3xl">
        <div>
          <BackToForms />
          <p className="mt-2 text-xs text-muted-foreground">
            What is this form for? It decides who fills it in, and what happens
            to the answers.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {FORM_PURPOSES.map((value) => {
            const Icon = PURPOSE_ICON[value];

            return (
              // A link, not a Button with a render slot: it navigates, so it is
              // an anchor (§2.1). The whole card is the target, which keeps it
              // well past the 24px minimum.
              <Link
                key={value}
                href={`/forms/new?purpose=${value}`}
                className="group flex flex-col gap-3 rounded-lg border bg-card grade-surface p-5 text-left shadow-raised-lg transition-colors hover:border-accent-border hover:bg-accent"
              >
                {/* The house icon tile: 32px, on the radius scale, raised.
                    Same shape as StatTile's and the nav user's. */}
                <span className="flex size-8 items-center justify-center rounded-md border bg-muted grade-chip text-foreground-muted shadow-raised">
                  <Icon aria-hidden className="size-4" />
                </span>
                <span className="text-lg font-semibold tracking-tight">
                  {FORM_PURPOSE_LABELS[value].label}
                </span>
                <span className="text-sm text-muted-foreground">
                  {FORM_PURPOSE_LABELS[value].hint}
                </span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-xs font-medium text-primary">
                  {value === "CLIENT_REQUEST" ? "Set it up" : "Name it and start"}
                  <ArrowRight aria-hidden className="size-3.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </PageShell>
    );
  }

  const supabase = await createClient();

  /*
   * Only offer departments this person can actually route to.
   *
   * ⚠️ THE ERROR IS STILL NOT SURFACED HERE, and that is a decision rather than
   * an oversight. This page has nothing to lose: it renders a blank settings
   * card for a form that does not exist yet, and a save with no department
   * selected is refused by the form's own schema, not by what this list
   * happened to contain. /forms/[id] is the one where an empty list can be
   * written back over a real form, and it treats the error accordingly.
   *
   * P7-66 adds one caller with a little more at stake: `defaultDepartmentId`
   * reads this list to pre-assign an engagement form. A failed read makes it
   * null, which is an unrouted draft the settings card can still fix — the same
   * outcome as leading several departments, and not a write over anything.
   */
  const { departments } = await loadRoutableDepartments(supabase, context);

  if (purpose === "EMPLOYEE_ENGAGEMENT") {
    return (
      <PageShell className="mx-auto w-full max-w-2xl">
        <div>
          <BackToForms />
          <p className="mt-2 text-xs text-muted-foreground">
            An employee engagement form. Staff fill it in signed in, and the
            answers are collected rather than approved.
          </p>
        </div>

        <div className="rounded-lg border bg-card grade-surface p-6 shadow-raised-lg">
          <EngagementCreate
            departmentId={defaultDepartmentId(context.primaryDepartmentId, departments)}
          />
        </div>
      </PageShell>
    );
  }

  // P2-06 — a brand-new form can point at an existing list straight away. Read
  // only on the client-request branch: `default_list_id` is where an APPROVED
  // request files, and an engagement form never has one.
  const { data: lists } = await supabase
    .from("vizserve_pms_lists")
    .select("id, name, department_id")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");

  return (
    <PageShell className="mx-auto w-full max-w-3xl">
      <div>
        <BackToForms />
        {/* No <h1> — the breadcrumb reads "Forms / New". This line survives
            because it says what happens next, which the crumb cannot. */}
        <p className="mt-2 text-xs text-muted-foreground">
          A client request form. Set it up here, then add the fields. It stays a
          draft until you publish it.
        </p>
      </div>

      <div className="rounded-lg border bg-card grade-surface p-6 shadow-raised-lg">
        {/* P7-66 Phase 4 — no `initial`, and no purpose to state. This branch is
            already the client-request one (`?purpose=`), and the card is now
            client-only: it hard-codes the purpose it sends. */}
        <ClientFormSettings departments={departments} lists={lists ?? []} />
      </div>
    </PageShell>
  );
}

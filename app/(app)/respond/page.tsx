import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FilePenLine } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = { title: "Fill a form" };

/**
 * P7-66 Phase 4b — WHAT THERE IS TO ANSWER.
 *
 * `/forms` is the BUILDER and is a team leader's screen. This is the other end
 * of the same table: the published internal forms anybody signed in
 * may fill in, which is why the nav row is called "Fill a form" rather than a
 * second "Forms" (lib/navigation.ts).
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
    .select("id, name, slug, description")
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

  const rows = forms ?? [];

  return (
    <PageShell>
      {rows.length === 0 ? (
        <EmptyState
          icon={<FilePenLine />}
          title="Nothing to fill in"
          description="Internal forms appear here once an admin publishes one. A client request form is not one of these — it has its own public link."
        />
      ) : (
        /*
         * A list of destinations, not a table. There is one thing to do with a
         * row — open it — and a table would spend three columns saying so.
         * `sm:grid-cols-2` keeps the card from running the width of a wide
         * screen for a two-word name, and it reflows to one column at 390px.
         */
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((form) => (
            <li key={form.id}>
              {/*
               * The whole card is the link, so the target is the object rather
               * than a small "Open" at the end of it — comfortably past the
               * 24×24 minimum, and one tab stop per form.
               */}
              <Link
                href={`/respond/${form.slug}`}
                className="group flex h-full flex-col gap-1.5 rounded-lg border bg-card p-4 grade-surface shadow-raised transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="flex items-start gap-2">
                  <FilePenLine
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-accent-foreground"
                  />
                  <span className="min-w-0 flex-1 text-sm font-semibold tracking-[-0.014em]">
                    {form.name}
                  </span>
                  <ArrowRight
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-foreground-faint group-hover:text-accent-foreground"
                  />
                </span>

                {form.description ? (
                  <span className="line-clamp-3 pl-6 text-xs leading-relaxed text-muted-foreground group-hover:text-accent-foreground">
                    {form.description}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

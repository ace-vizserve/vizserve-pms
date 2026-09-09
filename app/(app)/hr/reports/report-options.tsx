"use client";

import { useQuery } from "@tanstack/react-query";

import { CardSkeleton } from "@/components/skeletons";
import { QueryError } from "@/components/query-error";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDepartments, fetchDirectory, fetchLeaveTypes } from "@/lib/query/fetchers/ref";
import { qk } from "@/lib/query/keys";

import { ReportBuilder } from "./report-builder";

/**
 * P12-20 — the three pickers on `/hr/reports`, read from the reference cache.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THE ONE HR PATH THIS PHASE TOUCHES, AND ONLY ITS READS.
 *
 * Settled decision 5 keeps `/admin`, `/settings` and the rest of `/hr` server
 * -rendered permanently — low traffic, nobody needs SPA feel on a holidays
 * table. `/hr/reports` is the exception because of WHAT it reads rather than
 * where it lives: its three queries are the staff directory, the departments
 * and the leave types, which is three sevenths of the whole reference set, and
 * every one of them is already in the cache by the time somebody navigates here
 * from anywhere else in the app.
 *
 * ⚠️ WHAT IT COST BEFORE: three RLS-scoped round trips on every visit and on
 * every back-button return, for data that changes when HR adds a colleague.
 * What it costs now, arriving from any task screen: nothing at all — `/tasks`
 * has already populated `qk.ref("users")` and `qk.ref("departments")`, and
 * `REF_STALE_TIME` is ten minutes.
 *
 * ⚠️ A WRAPPER RATHER THAN A CONVERSION OF `ReportBuilder`, AND THAT IS THE
 * WHOLE DESIGN. That component has TWO homes: this page, and a "Leave audit"
 * dialog on `/admin/users` — which stays server-rendered and hands it the same
 * three lists as props read in its own RSC. Putting `useQuery` inside the
 * builder would have dragged `/admin/users` into this phase through a shared
 * component, which is exactly the pull the brief says to stop at and report.
 * So the builder keeps its props contract untouched and this file supplies them
 * from the cache on the one screen that has one.
 *
 * ⚠️ AND NONE OF THESE READS MAY FALL BACK TO `[]`. The page did
 * `people ?? []`, `departments ?? []`, `types ?? []` — it surfaced a failure on
 * the FIRST of the three and swallowed the other two, so a departments query
 * that died rendered as a builder with an empty Departments box. Nothing on
 * screen distinguishes that from a company with one department, and the export
 * it produces is an audit document: unticked means "everything", so the person
 * would have got a correct PDF from a screen that had lied to them about what
 * they were choosing between. `read()` throws and all three land here.
 * ------------------------------------------------------------------------
 */
export function ReportOptions({ currentYear, today }: { currentYear: number; today: string }) {
  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still rendered on the server for its initial
   * HTML and `createBrowserClient` reaches for `document.cookie`, which does not
   * exist there. A `queryFn` only ever runs in the browser.
   *
   * ⚠️ NONE OF THE THREE PASSES A `staleTime` AND NONE OF THEM SHOULD.
   * `makeQueryClient()` sets `REF_STALE_TIME` as a PREFIX DEFAULT on `["ref"]`,
   * so every entry under that root inherits ten minutes whether or not the
   * person adding it remembers — which is the whole reason it was moved there
   * in P12-20, having been declared since Phase 0 and applied by nobody.
   */
  const peopleQuery = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
  });

  const departmentsQuery = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchDepartments(browserClient()),
  });

  const typesQuery = useQuery({
    queryKey: qk.ref("leave-types"),
    queryFn: () => fetchLeaveTypes(browserClient()),
  });

  /*
   * ⚠️ ONE FAILURE STOPS THE BUILDER, WHERE THE PAGE USED TO STOP ONLY ON THE
   * PEOPLE READ. All three lists are filters on one document and the export
   * reads "nothing ticked means everything" — so a box that is empty because
   * its query died is a filter somebody did not apply and does not know they
   * did not apply. There is no partial state of this screen worth offering.
   */
  const failure = peopleQuery.error ?? departmentsQuery.error ?? typesQuery.error;
  if (failure) {
    return <QueryError what="the report options" message={failure.message} />;
  }

  if (!peopleQuery.data || !departmentsQuery.data || !typesQuery.data) {
    /* The builder is one card, so its placeholder is one card. */
    return <CardSkeleton lines={6} />;
  }

  return (
    <ReportBuilder
      currentYear={currentYear}
      today={today}
      /*
       * ⚠️ THE ORDER IS RESTORED HERE, NOT ASKED FOR IN THE QUERY. The page
       * ordered its staff read `is_active desc, full_name` so the people who
       * still work here come first; `qk.ref("users")` is shared with three task
       * surfaces and comes back by name alone. Sorting a directory of sixteen
       * in the browser is free, and asking the shared entry for a different
       * ORDER would mean two cache entries for one row set.
       *
       * ⚠️ DEACTIVATED PEOPLE STAY IN THE LIST, and that is the point of this
       * report rather than an accident of the shared entry: an auditor asking
       * what leave somebody took in March is usually asking BECAUSE they have
       * since left. The builder greys them; it does not drop them.
       */
      people={[...peopleQuery.data].sort(
        (a, b) =>
          Number(b.is_active) - Number(a.is_active) || a.full_name.localeCompare(b.full_name),
      )}
      /*
       * Retired departments and retired leave types are BOTH offered, exactly
       * as the page offered them: filtering an audit TO a withdrawn type — or
       * to a department that was folded into another one in June — is the
       * question this report exists to answer. `lib/query/fetchers/ref.ts` is
       * why both entries hold the whole table.
       */
      departments={departmentsQuery.data}
      leaveTypes={typesQuery.data}
    />
  );
}

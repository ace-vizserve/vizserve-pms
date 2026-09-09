import type { Metadata } from "next";

import { requireHr } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { currentBalanceYear } from "@/lib/schemas/leave-balances";
import { PageShell } from "@/components/page-shell";

import { ReportOptions } from "./report-options";

export const metadata: Metadata = { title: "Leave reports" };

/**
 * P7-53 — the leave audit, with its filters exposed.
 *
 * The report has existed since P7-34 as a single button on `/admin/users` that
 * printed EVERYBODY, WHOLE-YEAR, ALL TYPES, always — one argument, `p_year`.
 * This is the same document with the four filters HR asked for, plus a second
 * mode for an arbitrary period.
 *
 * ⚠️ THE PICKERS ARE NOT THE AUTHORITY. Everything offered below is read
 * through the ordinary RLS client, so a lead opening this screen sees only the
 * people they lead in the staff picker — but that is a convenience, not a
 * control. Both RPCs re-check scope themselves, because they are SECURITY
 * DEFINER and bypass every policy that produced these lists. Picking somebody
 * you may not see returns no rows rather than their record.
 *
 * ------------------------------------------------------------------------
 * ⚠️ P12-20 — THE THREE PICKER READS LEFT THIS FILE AND THE GATE DID NOT.
 *
 * `requireHr()` runs here, on the server, and must: settled decision 6 says
 * authentication does not move in any phase of this migration. What moved is
 * the staff directory, the departments and the leave types — three RLS-scoped
 * round trips issued on every visit and every back-button return, for the three
 * tables the rest of the app has already cached under `qk.ref(...)`. They are
 * now `ReportOptions`, which reads them from that cache with a ten-minute stale
 * time and reports a failure instead of rendering an empty filter box.
 *
 * ⚠️ THE TWO DATES STAY SERVER-COMPUTED AND ARRIVE AS PROPS. `todayInAppZone()`
 * is Manila's today, and a browser in another timezone answering that question
 * for itself would put a different default year on an audit document than the
 * one the server's RPC will bound. It is a fact about the app, not about the
 * reader's machine, so it is resolved once on this side of the wire — the same
 * reason `viewer` is built here and not there on every screen this phase
 * touched.
 * ------------------------------------------------------------------------
 */
export default async function LeaveReportsPage() {
  await requireHr();

  return (
    <PageShell>
      {/* The intro paragraph that used to sit here is gone. It explained the
          difference between the two documents in five lines of 12px grey, and
          the builder now explains it on the two cards you choose between — in
          the place where the choice is actually made, and in one set of words
          instead of two. */}
      <ReportOptions currentYear={currentBalanceYear(todayInAppZone())} today={todayInAppZone()} />
    </PageShell>
  );
}

import type { Metadata } from "next";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { loadPunchState } from "@/lib/dtr-server";
import {
  DTR_DEFAULT_SORT,
  DTR_SORTS,
  defaultDtrRange,
  type DtrSort,
} from "@/lib/query/fetchers/dtr";
import { PageShell } from "@/components/page-shell";

import { DtrView } from "./dtr-view";
import { PunchPanel } from "./punch-panel";

export const metadata: Metadata = { title: "DTR" };

/**
 * P5-04 / P12-23 — the daily time record: the SERVER half.
 *
 * "Default view nyan, pag-click, is yung list view lang ng mga time in, time
 * out" (Amier, 19:10). A list of days, not a calendar and not a chart — this is
 * the screen someone opens to check whether yesterday recorded properly.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THE FIVE QUERIES AND EVERY DERIVATION THAT USED TO BE HERE ARE IN
 * `lib/query/fetchers/dtr.ts`, BEHIND `qk.dtrView(filters)`. What is left is
 * what must not move — plus one read that DELIBERATELY DID NOT:
 *
 *   1. `requireAuthContext()` — the temporary-password wall, the `app_access`
 *      gate and the deactivation check.
 *   2. THE URL. The range, the person and the sort are the shareable source of
 *      truth for this screen; they are read once, here, and handed down as the
 *      filter half of the cache key. Re-reading them in the browser is how a key
 *      and a query drift by one navigation.
 *   3. `roleAtLeast` — `lib/auth/authorization.ts` is `server-only`, and a
 *      client component deciding its own scope is the "scattered
 *      `if (role === 'admin')`" CLAUDE.md exists to forbid. It decides whether a
 *      PERSON PICKER and an Export button are offered, nothing more: the
 *      policies are what scope the rows.
 *   4. ⚠️ `loadPunchState` STAYS, AND IT IS NOT AN OVERSIGHT. It seeds
 *      `qk.punchState()` so the card people open this page to CLICK is painted
 *      in the first HTML rather than after hydration — Next's own SPA guidance,
 *      and the same reason `/` and `/dashboard` keep their copy. The cache owns
 *      it from that moment on; every refetch goes browser-to-PostgREST through
 *      `fetchPunchState`.
 *
 * SCOPE IS RLS'S JOB. Not one query behind this page carries a department filter
 * or a `user_id = me` clause: the policy returns your own rows plus your team's
 * if you lead one. Restating that here would imply the policy is optional, and
 * would drift from it the first time either changed.
 * ------------------------------------------------------------------------
 */
export default async function DtrPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; user?: string; sort?: string; dir?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;

  /* `undefined` when the URL named no sort we recognise, and that distinction is
     load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
     collapsed into `dtrSort` below. */
  const requestedSort: DtrSort | undefined = (DTR_SORTS as readonly string[]).includes(
    params.sort ?? "",
  )
    ? (params.sort as DtrSort)
    : undefined;
  const dtrSort: DtrSort = requestedSort ?? DTR_DEFAULT_SORT.sort;
  /* ONE SOURCE FOR THE DIRECTION. An explicit sort obeys `?dir=` — ascending
     unless it says otherwise, which is why the table leaves `asc` out of the URL
     — and no explicit sort takes the default's. Deriving the direction from the
     COLUMN NAME, as this did (`dtrSort !== "date"`), meant a click on Date wrote
     `?sort=date` with no `dir`, the header drew ascending and Postgres returned
     descending: the arrow and the rows disagreed, and Date could not be read
     oldest-first at all. */
  const dtrAscending = requestedSort ? params.dir !== "desc" : DTR_DEFAULT_SORT.ascending;

  const today = todayInAppZone();
  const range = defaultDtrRange(today);
  const from = params.from ?? range.from;
  const to = params.to ?? range.to;
  const selectedUser = params.user ?? null;

  // A range that runs backwards matches nothing, and "nothing" is exactly what
  // an honestly empty record looks like — so the page has to say which it is.
  // `dtrExportSchema` already refuses `to < from`; this is the screen catching
  // up with the export rather than quietly disagreeing with it.
  const rangeInverted = from > to;

  const isLead = roleAtLeast(context.role, "team_leader");

  const punchState = await loadPunchState(context.userId);

  /**
   * F — whose record is this row?
   *
   * A lead reading their team's DTR must NOT be offered the correction links.
   * The correction would be filed against their own record, because
   * `vizserve_pms_submit_internal_request` resolves the requester from the
   * caller — so a lead clicking "Time-in missing?" on somebody else's gap would
   * silently raise a request about their own day. Correcting for somebody else
   * is not a thing this system does, and the honest response is to not offer it.
   * `viewerId` is what `isMine` in `dtr-table.tsx` reads to decide.
   */
  return (
    <PageShell className="gap-3 lg:overflow-hidden">
      <DtrView
        /* Built here, rendered inside the rail. See `DtrView`. */
        punchPanel={<PunchPanel initial={punchState} viewerId={context.userId} />}
        viewerId={context.userId}
        from={from}
        to={to}
        selectedUser={selectedUser}
        sort={dtrSort}
        ascending={dtrAscending}
        rangeInverted={rangeInverted}
        isLead={isLead}
      />
    </PageShell>
  );
}

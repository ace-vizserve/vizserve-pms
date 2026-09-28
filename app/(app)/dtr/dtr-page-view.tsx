"use client";

import { useSearchParams } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { useAuth } from "@/lib/auth/client-auth";
import { roleAtLeast } from "@/lib/auth/roles";
import { todayInAppZone } from "@/lib/dates";
import { DTR_DEFAULT_SORT, DTR_SORTS, defaultDtrRange, type DtrSort } from "@/lib/query/fetchers/dtr";

import { DtrView } from "./dtr-view";
import { PunchPanel } from "./punch-panel";

/**
 * P12 Phase A — the DTR page, entirely in the browser: the range and sort from
 * the URL, the viewer from the layout's auth context, the rows and the punch
 * panel from the query cache. RLS scopes every read (owner or department lead).
 */
export function DtrPageView() {
  const auth = useAuth();
  const search = useSearchParams();
  const params = {
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
    user: search.get("user") ?? undefined,
    sort: search.get("sort") ?? undefined,
    dir: search.get("dir") ?? undefined,
  };


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

  const isLead = roleAtLeast(auth.role, "team_leader");


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
        punchPanel={<PunchPanel viewerId={auth.userId} />}
        viewerId={auth.userId}
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

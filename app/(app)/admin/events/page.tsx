import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { holidayYearSchema } from "@/lib/schemas/holidays";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { EventsTable } from "./events-table";

export const metadata: Metadata = { title: "Events" };

/**
 * P7-46 — the events an admin puts on the shared calendar.
 *
 * A SIBLING OF /admin/holidays AND NOT A MERGE OF IT. The two screens look
 * almost identical and mean opposite things: a holiday says nobody is scheduled
 * to work, and two database functions consult it to compute leave days and
 * client deadlines. An event says something is happening and people are working
 * through it. Nothing here feeds any arithmetic, which is why this screen has no
 * closed-year warning and the holiday one does.
 *
 * Read through the ORDINARY RLS-scoped client. The policy is "any active user
 * reads, admin writes", so the same query a member runs returns the same rows —
 * worth keeping true. The service role appears only in the write actions.
 *
 * ONE YEAR AT A TIME, with the year in the URL, for the same reason the holiday
 * list does it: this table grows forever and a single list of every event the
 * company has ever held is not something anybody scans.
 */
export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  await requireRole("owner");
  const supabase = await createClient();

  const params = await searchParams;
  const requested = Array.isArray(params.year) ? params.year[0] : params.year;

  // Manila's year, not the server's — on 1 January a UTC server is still in
  // December, and this screen would open on the year that just ended.
  const currentYear = Number(todayInAppZone().slice(0, 4));

  // Narrowed rather than trusted, and falling back rather than throwing: a
  // mangled `?year=banana` should open the current year, not an error page.
  const parsedYear = holidayYearSchema.safeParse(requested ?? currentYear);
  const year = parsedYear.success ? parsedYear.data : currentYear;

  const [{ data: events, error }, { data: departments }] = await Promise.all([
    supabase
      .from("vizserve_pms_events")
      .select("id, title, description, category, department_id, start_date, end_date")
      // OVERLAP, not containment. An event running 28 Dec – 2 Jan belongs in
      // both years' lists; `start_date >= Jan 1` would drop it from the year it
      // finishes in, where people are still living through it.
      .lte("start_date", `${year}-12-31`)
      .gte("end_date", `${year}-01-01`)
      .order("start_date"),
    supabase.from("vizserve_pms_departments").select("id, name").order("name"),
  ]);

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Admin / Events". This paragraph carries
          the one thing the screen cannot show: what these are NOT. */}
      <p className="text-xs text-muted-foreground">
        Things happening — a town hall, an offsite, a team lunch. Every signed-in person sees them
        on the shared calendar, colour-coded by category.{" "}
        <strong className="font-medium text-foreground">These are not days off.</strong> Nothing
        here changes leave counts or client deadlines; that is what Holidays does.
      </p>

      {error ? (
        <QueryError what="the events calendar" message={error.message} />
      ) : (
        <EventsTable
          events={events ?? []}
          departments={departments ?? []}
          year={year}
          currentYear={currentYear}
        />
      )}
    </PageShell>
  );
}

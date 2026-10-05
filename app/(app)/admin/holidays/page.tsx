import type { Metadata } from "next";

import { requireHr } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { loadAllDepartments } from "@/lib/departments-server";
import { holidayYearSchema } from "@/lib/schemas/holidays";
import { createClient } from "@/utils/supabase/server";
import { LinkTabs } from "@/components/link-tabs";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { EventsTable } from "../events/events-table";
import { HolidaysTable } from "./holidays-table";

export const metadata: Metadata = { title: "Holidays & events" };

/**
 * P15-12 — HOLIDAYS AND EVENTS ON ONE PAGE, a tab each.
 *
 * They were two sibling screens with near-identical tables, both HR's and both
 * feeding the one shared calendar. They still MEAN opposite things — a holiday
 * is a day off that leave and client deadlines count around, an event is
 * something happening that changes no arithmetic — so they stay two tables and
 * two tabs, each with its own sentence saying which it is. `/admin/events`
 * redirects here with `?tab=events`, so a bookmark still lands.
 *
 * P7-35 — the holiday calendar. Maintained by HR since P7-52; see actions.ts.
 * P7-46 — the events calendar; see ../events/actions.ts.
 *
 * Read through the ORDINARY RLS-scoped client, not the service role. Both
 * policies say "readable by any active user, writable by HR", so the same query
 * a member would run returns the same rows. The service role appears only in
 * the write actions, where the audit row needs it.
 *
 * ONE YEAR AT A TIME, from the URL, so a year is linkable — someone comparing
 * 2027 against a government circular can send the page.
 */
export default async function HolidaysAndEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[]; tab?: string | string[] }>;
}) {
  await requireHr();
  const supabase = await createClient();

  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const tab = first(params.tab) === "events" ? "events" : "holidays";

  // Manila's year, not the server's. In the first eight hours of 1 January a UTC
  // server is still in December, and this screen would open on the year that
  // just ended — which for the one screen used to enter NEXT year's holidays is
  // exactly backwards.
  const currentYear = Number(todayInAppZone().slice(0, 4));

  // Narrowed rather than trusted, and falling back rather than throwing: a
  // mangled `?year=banana` should open the current year, not an error page.
  const parsedYear = holidayYearSchema.safeParse(first(params.year) ?? currentYear);
  const year = parsedYear.success ? parsedYear.data : currentYear;

  const tabHref = (target: "holidays" | "events") => {
    const next = new URLSearchParams();
    if (target === "events") next.set("tab", "events");
    if (year !== currentYear) next.set("year", String(year));
    const query = next.toString();
    return query ? `/admin/holidays?${query}` : "/admin/holidays";
  };

  return (
    <PageShell>
      <LinkTabs
        label="Calendar"
        active={tab}
        tabs={[
          { key: "holidays", label: "Holidays", href: tabHref("holidays") },
          { key: "events", label: "Events", href: tabHref("events") },
        ]}
      />

      {tab === "holidays" ? <HolidaysTab year={year} currentYear={currentYear} supabase={supabase} /> : null}
      {tab === "events" ? <EventsTab year={year} currentYear={currentYear} supabase={supabase} /> : null}
    </PageShell>
  );
}

type TabProps = {
  year: number;
  currentYear: number;
  supabase: Awaited<ReturnType<typeof createClient>>;
};

async function HolidaysTab({ year, currentYear, supabase }: TabProps) {
  const { data: holidays, error } = await supabase
    .from("vizserve_pms_holidays")
    .select("holiday_date, name, created_at")
    .gte("holiday_date", `${year}-01-01`)
    .lte("holiday_date", `${year}-12-31`)
    .order("holiday_date");

  return (
    <>
      {/* The thing the table cannot show: what these dates actually do. Two
          consequences, and the second is the one that bites. */}
      <p className="text-xs text-muted-foreground">
        Days nobody is scheduled to work. Every signed-in person sees them on the shared calendar,
        and leave requests skip them — a week off across a holiday costs one day less. Changing a
        date in a year that has already closed moves leave figures that have already been reported.
      </p>

      {error ? (
        <QueryError what="the holiday calendar" message={error.message} />
      ) : (
        <HolidaysTable holidays={holidays ?? []} year={year} currentYear={currentYear} />
      )}
    </>
  );
}

async function EventsTab({ year, currentYear, supabase }: TabProps) {
  const [{ data: events, error }, departments] = await Promise.all([
    supabase
      .from("vizserve_pms_events")
      .select("id, title, description, category, department_id, start_date, end_date")
      // OVERLAP, not containment. An event running 28 Dec – 2 Jan belongs in
      // both years' lists; `start_date >= Jan 1` would drop it from the year it
      // finishes in, where people are still living through it.
      .lte("start_date", `${year}-12-31`)
      .gte("end_date", `${year}-01-01`)
      .order("start_date"),
    loadAllDepartments(),
  ]);

  return (
    <>
      {/* What these are NOT is the one thing the table cannot show. */}
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
          departments={departments}
          year={year}
          currentYear={currentYear}
        />
      )}
    </>
  );
}

import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/authorization";
import { todayInAppZone } from "@/lib/dates";
import { holidayYearSchema } from "@/lib/schemas/holidays";
import { createClient } from "@/utils/supabase/server";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";

import { HolidaysTable } from "./holidays-table";

export const metadata: Metadata = { title: "Holidays" };

/**
 * P7-35 — the holiday calendar an admin maintains.
 *
 * The table has existed since P4, seeded with 2026 and editable by nothing but a
 * migration. Two things made that untenable: movable holidays are proclaimed
 * annually so 2027 needs a list nobody has, and P7-33 made this table decide how
 * many working days a leave request consumes — and therefore what the December
 * audit says people have left.
 *
 * Read through the ORDINARY RLS-scoped client, not the service role, exactly as
 * `/admin/users` does. The policy already says "readable by any active user,
 * writable by an admin", so the same query a member would run returns the same
 * rows — and that is worth keeping true. The service role appears only in the
 * write actions, where the audit row needs it.
 *
 * ONE YEAR AT A TIME. The table will hold a decade before long, and a single
 * list of ninety dates is not a calendar anybody can check against a
 * proclamation. The year comes from the URL so the view is linkable — an admin
 * comparing 2027 against a government circular can send somebody the page.
 */
export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  await requireRole("admin");
  const supabase = await createClient();

  const params = await searchParams;
  const requested = Array.isArray(params.year) ? params.year[0] : params.year;

  // Manila's year, not the server's. In the first eight hours of 1 January a UTC
  // server is still in December, and this screen would open on the year that
  // just ended — which for the one screen used to enter NEXT year's holidays is
  // exactly backwards.
  const currentYear = Number(todayInAppZone().slice(0, 4));

  // Narrowed rather than trusted, and falling back rather than throwing: a
  // mangled `?year=banana` should open the current year, not an error page. The
  // same posture `/timesheet` takes with `?week=`.
  const parsedYear = holidayYearSchema.safeParse(requested ?? currentYear);
  const year = parsedYear.success ? parsedYear.data : currentYear;

  const { data: holidays, error } = await supabase
    .from("vizserve_pms_holidays")
    .select("holiday_date, name")
    .gte("holiday_date", `${year}-01-01`)
    .lte("holiday_date", `${year}-12-31`)
    .order("holiday_date");

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Admin / Holidays". This paragraph stays
          because it is the thing the screen cannot show: what these dates
          actually do. Two consequences, and the second is the one that bites. */}
      <p className="text-xs text-muted-foreground">
        Days nobody is scheduled to work. Every signed-in person sees them on the shared calendar,
        and leave requests skip them — a week off across a holiday costs one day less. Changing a
        date in a year that has already closed moves leave figures that have already been reported.
      </p>

      {error ? (
        <QueryError what="the holiday calendar" message={error.message} />
      ) : (
        <HolidaysTable
          holidays={holidays ?? []}
          year={year}
          currentYear={currentYear}
        />
      )}
    </PageShell>
  );
}

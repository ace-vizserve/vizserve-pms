import { redirect } from "next/navigation";

/**
 * P15-12 — events moved onto /admin/holidays as its second tab. This stays so a
 * bookmark or a link in the audit trail still lands on the events list, for
 * the year it named.
 */
export default async function EventsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const params = await searchParams;
  const year = Array.isArray(params.year) ? params.year[0] : params.year;
  redirect(year ? `/admin/holidays?tab=events&year=${encodeURIComponent(year)}` : "/admin/holidays?tab=events");
}

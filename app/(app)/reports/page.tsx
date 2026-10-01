import { redirect } from "next/navigation";

/**
 * P15-02 — Reports became Analytics → Client results. Kept as a redirect so old
 * links and bookmarks still land, with their period and department.
 */
export default async function ReportsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const query = params.toString();
  redirect(query ? `/analytics/client?${query}` : "/analytics/client");
}

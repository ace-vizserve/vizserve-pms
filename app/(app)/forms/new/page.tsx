import { redirect } from "next/navigation";

/**
 * P17-15 — there is no new-form screen any more: New form creates a draft and opens
 * the builder. This keeps a bookmark or an old link from being a 404.
 */
export default async function NewFormPage({
  searchParams,
}: {
  searchParams: Promise<{ purpose?: string | string[] }>;
}) {
  redirect((await searchParams).purpose === "CLIENT_REQUEST" ? "/requests/forms" : "/forms");
}

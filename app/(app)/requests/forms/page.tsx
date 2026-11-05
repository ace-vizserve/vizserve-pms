import type { Metadata } from "next";

import { FormsList } from "@/app/(app)/forms/forms-list";

export const metadata: Metadata = { title: "Request forms" };

/** P17-15 — the forms clients and requesters fill in, apart from surveys. */
export default async function RequestFormsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  return <FormsList purpose="CLIENT_REQUEST" basePath="/requests/forms" archived={(await searchParams).archived} />;
}

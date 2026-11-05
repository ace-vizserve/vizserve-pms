import type { Metadata } from "next";

import { FormsList } from "./forms-list";

export const metadata: Metadata = { title: "Surveys & Quizzes" };

export default async function SurveysPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  return <FormsList purpose="INTERNAL" basePath="/forms" archived={(await searchParams).archived} />;
}

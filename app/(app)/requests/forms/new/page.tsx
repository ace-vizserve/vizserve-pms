import type { Metadata } from "next";

import { OpenNewForm } from "./open-new-form";

export const metadata: Metadata = { title: "Request form" };

/**
 * P17-15 — where the sidebar's Request form goes: straight into a new form's builder.
 * The list is at /requests/forms, a button away on Requests, and answers land in Requests.
 */
export default function NewRequestFormPage() {
  return <OpenNewForm />;
}

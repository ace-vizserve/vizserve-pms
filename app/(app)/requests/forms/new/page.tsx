import { redirect } from "next/navigation";

/**
 * This used to create a draft on arrival, so just opening it from the sidebar made a form.
 * New form on the list does that now. This keeps a bookmark or an old link from being a 404.
 */
export default function NewRequestFormPage() {
  redirect("/requests/forms");
}

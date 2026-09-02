import type { FormPurpose } from "@/lib/schemas/forms";

/**
 * P7-66 — WHICH TABS THE BUILDER OFFERS, AND WHICH ONE IT OPENS ON.
 *
 * ⚠️ ITS OWN MODULE, WITH NO `"use client"`, AND THAT IS THE WHOLE REASON IT
 * EXISTS. This lived in `builder-tabs.tsx` beside the component that uses it,
 * which is a client module — so the server page calling `resolveBuilderTab`
 * crashed at request time:
 *
 *   Attempted to call resolveBuilderTab() from the server but resolveBuilderTab
 *   is on the client. It's not possible to invoke a client function from the
 *   server, it can only be rendered as a Component or passed to props of a
 *   Client Component.
 *
 * `"use client"` marks a module boundary, not a hint: every export of that file
 * becomes a client reference, including the pure ones. Typecheck cannot see it
 * — the types line up perfectly — so this is a class of bug that only a browser
 * or a running dev server catches.
 *
 * A shared module is importable from both sides, and being pure it is also
 * testable without a DOM.
 */

export const BUILDER_TABS = ["questions", "responses", "settings"] as const;

export type BuilderTab = (typeof BUILDER_TABS)[number];

/**
 * ⚠️ P7-66 Phase 4 — A CLIENT FORM HAS NO RESPONSES TAB, AND THAT IS A PRODUCT
 * DECISION RATHER THAN A TIDY-UP.
 *
 * The two purposes are different products sharing one builder. A submission to
 * a CLIENT_REQUEST form is not an answer sheet — it MINTS A REQUEST, with a
 * reference number the client quotes back, a status, a Gate 1 decision, an SLA
 * clock and a task once it is approved. All of that already has a screen, at
 * /requests, and /requests is the ONE place requests are read.
 *
 * A second door onto them here would be a screen that shows less, disagrees
 * about what a submission IS, and is the more convenient of the two — which is
 * how a queue quietly stops being the queue. So the tab is not built, not
 * emptied and not disabled: it is not offered.
 *
 * An EMPLOYEE_ENGAGEMENT form is the opposite case. Its answers are stored
 * nowhere else and have no other screen, so the tab on the form IS the place
 * they are read.
 */
export function builderTabsFor(purpose: FormPurpose): readonly BuilderTab[] {
  return purpose === "EMPLOYEE_ENGAGEMENT"
    ? BUILDER_TABS
    : BUILDER_TABS.filter((tab) => tab !== "responses");
}

/**
 * Narrows a raw `?tab=` to one this form actually offers. Anything else opens
 * on Questions.
 *
 * ⚠️ AN ALLOWLIST, NOT A CAST. The value comes from the URL bar, and it is fed
 * to Base UI's `Tabs` as the selected value — an unrecognised one selects no
 * panel at all, so `?tab=x` would render the builder as an empty page with a tab
 * strip on top.
 *
 * ⚠️ AND THE ALLOWLIST IS THE FORM'S, NOT THE FULL SET. `?tab=responses` is a
 * live link in somebody's history from before Phase 4, and on a client form
 * that tab no longer exists — selecting it would produce exactly the empty page
 * above. It falls back to Questions like any other unknown value.
 */
export function resolveBuilderTab(
  raw: string | undefined,
  offered: readonly BuilderTab[],
): BuilderTab {
  return offered.find((tab) => tab === raw) ?? "questions";
}

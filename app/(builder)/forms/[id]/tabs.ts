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
 * The tabs a form offers. Since P15-05 that is all three on both purposes: an
 * internal form's Responses tab reads its answers, a client form's lists the
 * requests it produced (each opening at /requests/[id], where it is approved).
 * P7-66 Phase 4 had removed the client tab; it came back on request.
 */
export function builderTabsFor(): readonly BuilderTab[] {
  return BUILDER_TABS;
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

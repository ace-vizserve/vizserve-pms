/**
 * P7-66 — WHICH TAB THE BUILDER OPENS ON.
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
 * Narrows a raw `?tab=` to a real one. Anything else opens on Questions.
 *
 * ⚠️ AN ALLOWLIST, NOT A CAST. The value comes from the URL bar, and it is fed
 * to Base UI's `Tabs` as the selected value — an unrecognised one selects no
 * panel at all, so `?tab=x` would render the builder as an empty page with a tab
 * strip on top.
 */
export function resolveBuilderTab(raw: string | undefined): BuilderTab {
  return BUILDER_TABS.find((tab) => tab === raw) ?? "questions";
}

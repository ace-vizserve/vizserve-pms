"use client";

import { createContext, useContext } from "react";

/**
 * P12 — "is this table row armed?"
 *
 * A task row mounts about a dozen interactive widgets (popovers, menus, a
 * dialog, tooltips). Built for every visible row on every visit, they were the
 * bulk of the time to open a list. An UNARMED row draws each control's trigger
 * as a plain `<button>` — same classes, same label, same contents, so it looks
 * identical — without the popover machinery behind it. The row arms (builds the
 * real controls) when the pointer enters it, when focus lands in it, or during
 * idle time shortly after the page settles; see `ArmableRow` in
 * `components/data-table.tsx`.
 *
 * ⚠️ DEFAULTS TO TRUE, so every control used outside an armable table — the
 * board, the task page, dialogs — behaves exactly as before.
 *
 * `data-arm-slot` on both the plain button and the real trigger is how focus is
 * handed across when a keyboard user tabs into an unarmed row: the row arms, and
 * focus moves to the real control in the same slot.
 */
export const RowArmedContext = createContext(true);

export function useRowArmed(): boolean {
  return useContext(RowArmedContext);
}

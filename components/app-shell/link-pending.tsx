"use client";

import { useLinkStatus } from "next/link";

/**
 * P11-05 — a click that has been registered but not yet answered.
 *
 * ⚠️ THIS IS THE GAP `loading.tsx` DOES NOT COVER. A route's loading state is
 * itself prefetched, so on a slow or unstable connection it may not have
 * arrived when somebody clicks — and until it does, the click produces nothing
 * at all. Next's own guidance for that case is this hook; it is the only thing
 * that can speak before the server has been heard from.
 *
 * ⚠️ IT MUST NOT FLASH ON A FAST NAVIGATION, which is why the animation starts
 * at `opacity: 0` with a delay rather than being conditionally rendered. A
 * spinner that appears and vanishes inside 80ms reads as a glitch, and most
 * navigations in this app are that fast. Under the delay nothing is ever seen;
 * over it, the dot fades up and says the app heard you.
 *
 * Renders inside a `<Link>` — `useLinkStatus` reads the transition of the
 * nearest one and returns `pending: false` anywhere else.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();

  if (!pending) return null;

  return (
    <span
      // Decoration. The route change is announced by the router, and a second
      // live region here would interrupt it.
      aria-hidden
      className="link-pending ml-auto size-1.5 shrink-0 rounded-full bg-current"
    />
  );
}

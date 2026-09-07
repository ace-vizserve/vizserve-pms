import { ViewTransition } from "react";

/**
 * P11-05 — the handoff from a skeleton to the thing it stood in for.
 *
 * Without this the swap is instant: the skeleton vanishes and the content pops
 * in. Two of them on a page land at different moments and the effect is a page
 * that twitches. A short directional pair reads as one thing yielding to
 * another — the placeholder slides down and out, the content slides up and in.
 *
 * ⚠️ USED AS A PAIR OR NOT AT ALL. `<RevealFallback>` goes around the Suspense
 * fallback and `<Reveal>` around its children. One without the other animates
 * half a handoff, which looks like a glitch rather than a transition.
 *
 *     <Suspense fallback={<RevealFallback><Skeleton /></RevealFallback>}>
 *       <Reveal><Content /></Reveal>
 *     </Suspense>
 *
 * ⚠️ `default="none"` ON BOTH, AND IT IS LOAD-BEARING. A `<ViewTransition>`
 * without it animates on EVERY transition anywhere in the tree — so changing a
 * task's status would slide the whole list, and switching theme would slide the
 * page. Naming the animation for enter/exit only keeps each one to the moment it
 * is about.
 *
 * The animation itself is four CSS rules in `app/globals.css` keyed off the
 * `reveal-in` / `reveal-out` classes, and the whole set is disabled under
 * `prefers-reduced-motion` (§1.7).
 */
export function Reveal({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="reveal-in" default="none">
      {children}
    </ViewTransition>
  );
}

export function RevealFallback({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition exit="reveal-out" default="none">
      {children}
    </ViewTransition>
  );
}

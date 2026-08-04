"use client";

import type { ComponentProps, MouseEvent, ReactNode } from "react";

/**
 * An in-page anchor that eases to its target instead of teleporting.
 *
 * Done in JS rather than `html { scroll-behavior: smooth }` because that
 * property applies to the scrolling element globally — it would also animate
 * the App Router's scroll-to-top on every navigation inside the product, which
 * is a dense queue tool where that reads as lag. This keeps the easing on the
 * marketing page, where it is decoration.
 *
 * Two things it must not break:
 *  - **Reduced motion.** A large animated scroll is a vestibular trigger, so
 *    `prefers-reduced-motion` falls back to an instant jump.
 *  - **Keyboard focus.** Scrolling moves the viewport but not the caret, so a
 *    keyboard user would tab from the old position. Focus moves to the section
 *    with `preventScroll` so it lands without fighting the animation.
 */
export function ScrollLink({
  href,
  children,
  className,
  onNavigate,
  // Rest props are forwarded so this composes under `<Button render={…} />` —
  // Base UI hands the rendered element its data-slot/aria attributes, and
  // dropping them silently would leave the button unstyled in any rule that
  // keys off them.
  ...rest
}: Omit<ComponentProps<"a">, "href" | "onClick"> & {
  /** Same-page hash target, e.g. `#modules`. */
  href: `#${string}`;
  // Optional because as a `render` template this is written `<ScrollLink />`
  // with no children — Base UI injects the parent's children at runtime.
  children?: ReactNode;
  onNavigate?: () => void;
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    // Let the browser own modified clicks — open-in-new-tab still works.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = document.getElementById(href.slice(1));
    // No target on this page? Leave the default behaviour alone rather than
    // swallowing the click.
    if (!target) return;

    event.preventDefault();
    onNavigate?.();

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    target.scrollIntoView({
      // `scroll-mt-*` on the section is what keeps the heading clear of the
      // sticky header — scrollIntoView honours scroll-margin.
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });

    target.focus({ preventScroll: true });

    // replaceState, not pushState: the hash stays shareable, but Back still
    // leaves the page instead of unwinding a stack of section jumps.
    history.replaceState(null, "", href);
  }

  return (
    <a {...rest} href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * P11-05 — a link that prefetches when you point at it, not when it scrolls
 * into view.
 *
 * ⚠️ THE DEFAULT IS WRONG FOR LONG LISTS, WHICH IS THE WHOLE REASON THIS EXISTS.
 * A visible `<Link>` prefetches as it enters the viewport. On a task list that is
 * one server request per row on screen, and a department's list runs to
 * hundreds — so the browser spends the whole scroll rendering detail pages
 * nobody asked for, and the requests that matter queue behind them.
 *
 * Hover is the cheapest available signal of intent. Next's own guidance for
 * large lists is exactly this shape:
 *
 *     prefetch={active ? null : false}
 *
 * ⚠️ `null`, NOT `true`. `null` restores the DEFAULT behaviour — prefetch the
 * route's shell, and no more. `true` would additionally resolve params and
 * searchParams for every row somebody's cursor crosses on the way down the
 * page, which is most of them.
 *
 * ⚠️ IT NEVER GOES BACK TO FALSE. Once a row has been pointed at, its shell is
 * fetched and cached; flipping the prop back on mouse-out would discard that for
 * nothing. `active` is one-way on purpose.
 *
 * Touch has no hover. Those readers get the pre-P11 behaviour — the route is
 * fetched on tap — which is what they had before this and is why the fallback is
 * `false` rather than nothing.
 */
export function HoverPrefetchLink({
  href,
  className,
  children,
  ...rest
}: React.ComponentProps<typeof Link>) {
  const [active, setActive] = useState(false);

  return (
    <Link
      {...rest}
      href={href}
      className={className}
      prefetch={active ? null : false}
      onMouseEnter={() => setActive(true)}
      // Keyboard readers never fire mouseenter, and they are exactly the people
      // who tab down a list one row at a time before choosing.
      onFocus={() => setActive(true)}
    >
      {children}
    </Link>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { prefetchTask } from "@/lib/query/prefetch-task";

/** `/tasks/<uuid>` exactly — a list, the board or `/tasks/lists` is not a task page. */
const TASK_PAGE = /^\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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
 * Hover is the cheapest available signal of intent, so nothing is prefetched
 * until a row is pointed at or focused.
 *
 * ⚠️ `true` SINCE P12, WHERE THIS USED TO SAY `null`. `null` prefetched only
 * the route's shared shell, so the click still waited on the server for the
 * URL's own page. The pages behind these links became client pages, which makes
 * resolving the URL cheap — and it only happens for rows actually pointed at,
 * never for every row that scrolls past.
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
  const queryClient = useQueryClient();

  /*
   * P12-06 — A TASK PAGE READS FROM THE QUERY CACHE, so prefetching its route
   * shell alone warms nothing that matters: the data would still be read after
   * the click. On intent, the task's own reads start too, under the keys the
   * page uses, and the page usually finds them already in. Fresh entries are
   * not read again, so passing back and forth over a row costs nothing.
   */
  function activate() {
    setActive(true);
    const taskId = typeof href === "string" ? TASK_PAGE.exec(href)?.[1] : undefined;
    if (taskId) prefetchTask(queryClient, taskId);
  }

  return (
    <Link
      {...rest}
      href={href}
      className={className}
      // P12 — `true` once pointed at: resolve THIS URL's page before the click,
      // not just the route's shared shell (Next 16.3's per-link prefetching).
      // The destination pages are client pages, so what comes back is tiny; the
      // data itself is warmed into the query cache by `prefetchTask` below.
      prefetch={active ? true : false}
      onMouseEnter={activate}
      // Keyboard readers never fire mouseenter, and they are exactly the people
      // who tab down a list one row at a time before choosing.
      onFocus={activate}
    >
      {children}
    </Link>
  );
}

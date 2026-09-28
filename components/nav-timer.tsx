"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * P12 — a navigation stopwatch, for finding out where a slow click goes.
 *
 * Logs one line per client navigation to the browser console, split in two:
 *
 *   router — click → URL changed. Next waiting on the server (or its router
 *            cache) for the destination's payload. The top loader runs here.
 *   render — URL changed → next frame painted. React drawing the new page.
 *
 * ⚠️ STAGING AND LOCALHOST ONLY — it renders nothing and logs nothing on the
 * production hostname. A diagnostic, meant to be removed once the question is
 * answered.
 */
export function NavTimer() {
  const pathname = usePathname();
  const search = useSearchParams();
  const clickedAt = useRef<number | null>(null);
  const enabled = useRef(false);

  useEffect(() => {
    const host = window.location.hostname;
    enabled.current = host === "localhost" || host.includes("staging");
    if (!enabled.current) return;

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      clickedAt.current = performance.now();
    };

    // Capture phase, so it runs before the link's own handler starts routing.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const url = `${pathname}${search.size ? `?${search.toString()}` : ""}`;

  useEffect(() => {
    if (!enabled.current || clickedAt.current === null) return;

    const start = clickedAt.current;
    const committed = performance.now();
    clickedAt.current = null;

    // Two frames: the first runs before paint, the second after it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const painted = performance.now();
        console.info(
          `[nav] ${url} — router ${Math.round(committed - start)}ms · render ${Math.round(painted - committed)}ms · total ${Math.round(painted - start)}ms`,
        );
      }),
    );
  }, [url]);

  return null;
}

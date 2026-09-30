"use client";

import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Marks where the task search (`?q=`) matched inside a title.
 *
 * The same test the query makes — the typed text as ONE case-insensitive run
 * (`ilike '%q%'`), not word by word — so what lights up is exactly why the row
 * is on screen. Every occurrence is marked.
 *
 * Reads the URL itself rather than taking the query as a prop, so the list and
 * the board use it without threading `q` through every row.
 */
export function SearchHighlight({ text }: { text: string }) {
  const params = useSearchParams();
  return <Highlighted text={text} query={params.get("q")} />;
}

export function Highlighted({ text, query }: { text: string; query: string | null | undefined }) {
  const needle = query?.trim().toLowerCase();
  const haystack = text.toLowerCase();

  // A few characters change length when lowercased ("İ"), which would put the
  // marks in the wrong place — show the title plain rather than mismarked.
  if (!needle || haystack.length !== text.length) return text;

  const parts: ReactNode[] = [];
  let from = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-xs bg-highlight text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (parts.length === 0) return text;
  if (from < text.length) parts.push(text.slice(from));

  return <>{parts}</>;
}

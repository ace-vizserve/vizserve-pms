"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_SEARCH_LENGTH } from "@/lib/search";

/**
 * The debounced, URL-backed search box every list route uses.
 *
 * This was `app/(app)/inbox/inbox-search.tsx` with `/inbox` hard-coded in three
 * places. The audit trail needed the same control, and a second copy of a
 * debounced search is exactly how two lists end up with different debounce
 * windows and only one of them resetting the page — so it moved here and took a
 * `basePath` instead.
 *
 * Two things it has to get right:
 *
 *   1. **Reset the page.** Searching from page 4 must land on page 1 of the new
 *      results, not page 4 — which is usually past the end and renders empty.
 *      Dropping `page` on every term change is the whole fix.
 *   2. **Do not fight the user's typing.** The input is uncontrolled after
 *      mount; re-syncing it from the URL on every navigation would move the
 *      caret mid-word once the debounced push lands.
 */
export function ListSearch({
  initial,
  basePath,
  id,
  label = "Search",
  placeholder,
  className,
}: {
  initial: string;
  /** e.g. `/inbox`. Other filters in the URL are preserved. */
  basePath: string;
  /** Unique on the page — it wires the visible label to the input. */
  id: string;
  label?: string;
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending debounce must not outlive the component, or it navigates after
  // the user has left the page.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function push(term: string) {
    const next = new URLSearchParams(params.toString());
    if (term.trim()) next.set("q", term.trim());
    else next.delete("q");
    // See (1) above.
    next.delete("page");

    const query = next.toString();
    startTransition(() => router.push(query ? `${basePath}?${query}` : basePath));
  }

  function onChange(term: string) {
    setValue(term);
    if (timer.current) clearTimeout(timer.current);
    // 300ms: long enough that a typed word is one request, short enough that
    // the list feels like it is following you.
    timer.current = setTimeout(() => push(term), 300);
  }

  function clear() {
    if (timer.current) clearTimeout(timer.current);
    setValue("");
    push("");
  }

  return (
    // Same shape as the filter columns beside it: a small label over a control,
    // in a `space-y-1.5` stack. A bare input with an sr-only label sits a
    // label's height higher than everything next to it — the row lines up on
    // the bottom and still reads as crooked, because the tops do not.
    //
    // Width is the caller's business: these pages are full-bleed, and a search
    // box stretched across a 1600px monitor is a worse target than a short one.
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>

      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />

        <Input
          id={id}
          type="search"
          // `search` inputs render a native clear affordance in some browsers;
          // the explicit button below is the one that is keyboard-reachable and
          // present everywhere.
          value={value}
          maxLength={MAX_SEARCH_LENGTH}
          placeholder={placeholder}
          className="pr-9 pl-9"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") clear();
            if (event.key === "Enter") {
              event.preventDefault();
              if (timer.current) clearTimeout(timer.current);
              push(value);
            }
          }}
        />

        <div className="absolute top-1/2 right-3 -translate-y-1/2">
          {pending ? (
            <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
          ) : value ? (
            <button
              type="button"
              onClick={clear}
              className="rounded-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
              <span className="sr-only">Clear search</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

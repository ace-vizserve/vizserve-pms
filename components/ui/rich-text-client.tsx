"use client";

import { RICH_TEXT_CLASS } from "@/components/ui/rich-text";
import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";
import { cn } from "@/lib/utils";

/**
 * P12-06 — `<RichText>`, for a tree that fetched the row itself.
 *
 * ⚠️ THE TWIN OF `components/ui/rich-text.tsx`, AND IT EXISTS FOR ONE REASON.
 * That component sanitises as it renders, which is the pass nothing can bypass
 * (its header argues why write-side sanitising GUARDS nothing), and it can only
 * do that on the server because `sanitize-html` is a Node library of some size.
 * Its own note says so: "FOR CLIENT COMPONENTS: you cannot use this. Sanitise on
 * the server where the row is read, pass the safe string down."
 *
 * Phase 3a took away the place that used to happen. `/tasks/[id]` reads its rows
 * browser → PostgREST now, so there is no server render between the column and
 * the screen, and "sanitise where the row is read" means in the browser. The
 * sanitiser is `lib/rich-text-dom.ts` — a DOM-based implementation of the SAME
 * allowlist, sharing `RICH_TEXT_TAGS` rather than copying it. Read that file
 * before touching this one.
 *
 * ⚠️ `RICH_TEXT_CLASS` IS IMPORTED, NOT RESTATED. `whitespace-pre-wrap` in it is
 * not decoration — every row written before P7-56 is plain text whose line
 * breaks are real newlines rather than `<br>`, and a second copy of that class
 * string here is the drift the constant was extracted to prevent.
 * `comment-thread.tsx` already imports it from a `"use client"` file, so this
 * adds nothing to the bundle that page did not already carry.
 */
export function RichTextClient({
  html,
  className,
}: {
  html: string | null | undefined;
  className?: string;
}) {
  const safe = sanitizeRichTextInBrowser(html);
  if (!safe) return null;

  return (
    <div
      className={cn(RICH_TEXT_CLASS, className)}
      // Safe because `sanitizeRichTextInBrowser` ran on the line above, in this
      // render, on this value. Not because a caller promised.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

import { sanitizeRichText } from "@/lib/rich-text-server";
import { cn } from "@/lib/utils";

/**
 * P7-56 — render one of the six rich-text columns.
 *
 * ⚠️ NO `"use client"`, AND THAT IS LOAD-BEARING. `sanitize-html` is a Node
 * library of some size; a client component importing it would ship the whole
 * sanitiser to the browser on every page that renders a comment. This is a
 * server component, so the sanitising happens during the render that produces
 * the HTML and nothing extra reaches the client.
 *
 * ⚠️ IT SANITISES ON RENDER EVEN THOUGH THE ACTIONS SANITISE ON WRITE, and the
 * duplication is the design. Write-side sanitising keeps the database tidy; it
 * does not GUARD anything, because these columns are also reachable from a SQL
 * console, from `vizserve_pms_submit_request`, and from every row written before
 * this feature existed. The render-side pass is the one nothing can bypass —
 * exactly the argument this codebase already makes for RLS sitting under the
 * TypeScript authorization layer. Do not "optimise" it away.
 *
 * FOR CLIENT COMPONENTS: you cannot use this. Sanitise on the server where the
 * row is read, pass the safe string down, and render it with
 * `RICH_TEXT_CLASS` — see `comment-thread.tsx`, which is the one such case.
 */

/**
 * The prose styling, shared so the client-side render path cannot drift from
 * this one.
 *
 * ⚠️ `whitespace-pre-wrap` IS NOT DECORATION. Every row written before P7-56 is
 * plain text whose line breaks are real newlines rather than `<br>`. Drop this
 * class and every one of them collapses into a single paragraph.
 */
export const RICH_TEXT_CLASS = "rich-text text-sm whitespace-pre-wrap wrap-break-word";

export function RichText({
  html,
  className,
}: {
  html: string | null | undefined;
  className?: string;
}) {
  const safe = sanitizeRichText(html);
  if (!safe) return null;

  return (
    <div
      className={cn(RICH_TEXT_CLASS, className)}
      // Safe because `sanitizeRichText` ran on the line above, in this render,
      // on this value. Not because a caller promised.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

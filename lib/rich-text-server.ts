import sanitizeHtml from "sanitize-html";

import { RICH_TEXT_TAGS } from "@/lib/rich-text";

/**
 * P7-56 — the sanitiser. Server only, and the split is deliberate.
 *
 * ⚠️ `sanitize-html` IS A NODE LIBRARY OF SOME SIZE, and `lib/rich-text.ts` is
 * imported by zod schemas that client components use. Keeping the import here,
 * behind `server-only`, is what stops the whole sanitiser being bundled into
 * every page that renders a comment box. The same reason `settings-server.ts`
 * and `tasks-server.ts` exist beside their client-safe halves.
 *
 * ⚠️ IT IS ALSO THE SECURITY BOUNDARY, and only this function is. The flattener
 * next door strips tags with a regex, which is fine for producing TEXT — React
 * escapes a text node — and would be worthless for producing HTML. Never move
 * this to a regex, and never use the flattener to make something safe to render.
 */
export function sanitizeRichText(dirty: string | null | undefined): string {
  if (!dirty) return "";

  return sanitizeHtml(dirty, {
    allowedTags: [...RICH_TEXT_TAGS],
    /*
     * ⚠️ `rel` AND `target` MUST BE LISTED even though `transformTags` below is
     * what sets them. sanitize-html filters attributes AFTER transforming, so
     * omitting them here silently discards the very values the transform just
     * added — the link ends up with no `rel`, which is the whole point of it.
     * The transform still OVERWRITES whatever was stored, so a hostile
     * `target="_self"` cannot survive merely by being on the allowlist.
     */
    allowedAttributes: {
      a: ["href", "rel", "target"],
    },
    // ⚠️ NO `javascript:`. sanitize-html's default list is wider than this app
    // needs, and a link is the one place a user-supplied string reaches an
    // attribute rather than a text node.
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
    /*
     * `disallowedTagsMode` is left at its default, "discard", and that is a
     * decision rather than an omission. "escape" would keep a `<script>` as
     * visible text INCLUDING its body, printing an alert payload on the page in
     * full. Discard drops `script` and `style` wholesale — they are in
     * sanitize-html's `nonTextTags` — while ordinary prose containing a bare
     * `<` is still entity-escaped rather than eaten.
     */
  });
}

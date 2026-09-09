import { RICH_TEXT_TAGS, richTextToPlainText } from "@/lib/rich-text";

/**
 * P12-06 — the sanitiser for rich text the BROWSER fetched.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHY THIS EXISTS AT ALL, BECAUSE THE OBVIOUS READING IS THAT IT SHOULD NOT.
 *
 * `lib/rich-text-server.ts` is the sanitiser, it is `server-only`, and its
 * header says in capitals that it is the security boundary and must not move to
 * the client. `components/ui/rich-text.tsx` has no `"use client"` for the same
 * reason — `sanitize-html` is a Node library of some size, and a client
 * component importing it would ship the whole parser to the browser on every
 * page that renders a comment. Both of those remain true and neither is being
 * relaxed here.
 *
 * What changed is WHERE THE ROW IS READ. Until this phase every rich-text column
 * on `/tasks/[id]` was fetched in an RSC, so the sanitising happened during the
 * render that produced the HTML: `<RichText>` for the brief, and
 * `sanitizeRichText` in `page.tsx` for the comment bodies and the notes on
 * status-history rows, which `comment-thread.tsx` then painted (it is
 * `"use client"` and says exactly this — "already sanitised, on the server; if
 * you ever pass a body in from somewhere else, sanitise it there").
 *
 * Phase 3a moves those reads browser → PostgREST. There is no server render in
 * the path any more, so "sanitise it there" now means HERE, and the alternative
 * to writing this file was to drop the render-side pass entirely. That was not
 * on offer. `rich-text.tsx` argues why, and the argument survives the move
 * intact: the actions sanitise on WRITE, which keeps the column tidy and GUARDS
 * nothing, because these columns are also reachable from a SQL console, from
 * `vizserve_pms_submit_request`, and from every row written before P7-56
 * existed. The render-side pass is the one nothing can bypass — the same
 * argument this codebase already makes for RLS sitting under the TypeScript
 * authorization layer.
 * ------------------------------------------------------------------------
 *
 * ⚠️ IT IS A DIFFERENT IMPLEMENTATION OF THE SAME ALLOWLIST, NOT A SECOND
 * ALLOWLIST. `RICH_TEXT_TAGS` is imported, not copied, so the editor's schema,
 * the server sanitiser and this one cannot drift apart — that list is already
 * documented as one decision with the editor's extensions.
 *
 * ⚠️ AND IT BUILDS THE OUTPUT RATHER THAN FILTERING THE INPUT. Nothing from the
 * stored string is ever copied through: the walk creates FRESH elements of
 * allowlisted types and sets only attributes it names itself. An `onerror`, a
 * `style`, a `srcset`, an unknown tag or an attribute nobody has heard of is not
 * "removed" — it is never reached for. That is a smaller thing to get right than
 * a blocklist, and it is why this is ~40 lines rather than a vendored parser.
 *
 * ⚠️ `DOMParser` WITH `text/html` PRODUCES AN INERT DOCUMENT. It has no browsing
 * context and scripting is disabled, so nothing in the string executes, no image
 * loads and no `onerror` fires while it is being inspected. Parsing the untrusted
 * markup into a live `innerHTML` first would be the version of this that is a
 * vulnerability; do not "simplify" it into one.
 */

/** Everything the editor can produce. Imported so there is one list, not two. */
const ALLOWED = new Set<string>(RICH_TEXT_TAGS);

/**
 * Tags whose CONTENT goes with them.
 *
 * ⚠️ IT DOES NOT MIRROR `sanitize-html`'s `nonTextTags`, WHICH AN EARLIER
 * VERSION OF THIS COMMENT CLAIMED. That set is exactly
 * `script, style, textarea, option, xmp`. This one adds `noscript, iframe,
 * object, embed, template, title` — every one of which is a raw-text or
 * otherwise script-adjacent container the editor cannot produce — and, until
 * this commit, was missing `xmp`. The two lists differ on purpose; the review
 * that found the omission counted twelve behavioural divergences from the
 * server sanitiser in total, all of them either stricter or cosmetic.
 *
 * ⚠️ THE DEFAULT IS THE OTHER WAY ROUND. A disallowed tag is UNWRAPPED — `<div><p>hi</p></div>` keeps the
 * paragraph — because that is what `disallowedTagsMode: "discard"` does on the
 * server and because a `<span>` around a sentence must not eat the sentence.
 * These are the exceptions, where the text between the tags is code rather than
 * prose and printing it would put a script body on the page as visible text.
 */
const DROP_WITH_CONTENT = new Set([
  "script",
  // Raw-text elements. A serialiser does NOT escape their text children, so one
  // of these reaching the output with a copied text node writes live markup.
  // See the ordering note in `walk`.
  "xmp",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "template",
  "textarea",
  "option",
  "title",
]);

/**
 * ⚠️ BELT AND BRACES FOR THE ORDERING ABOVE. `walk` is now safe whichever way
 * the sets overlap, but an overlap would still mean a tag the editor is allowed
 * to produce is being silently discarded with its content — a data-loss bug
 * rather than a security one, and one nobody would notice from the rendered
 * output. Thrown at module load so it fails in the first test that imports this
 * file, not in production.
 */
for (const tag of DROP_WITH_CONTENT) {
  if (ALLOWED.has(tag)) {
    throw new Error(
      `rich-text-dom: "${tag}" is in both RICH_TEXT_TAGS and DROP_WITH_CONTENT. ` +
        `An allowed tag cannot also be dropped with its content — decide which it is.`,
    );
  }
}

/**
 * The only schemes a link may carry.
 *
 * ⚠️ NO `javascript:`. This is the one place a user-supplied string reaches an
 * ATTRIBUTE rather than a text node, so it is the one place that matters.
 *
 * ⚠️ AND A RELATIVE HREF IS REFUSED, which is a small, deliberate divergence
 * from the server sanitiser — `sanitize-html` lets a naked path through.
 * Everything the editor produces is absolute (tiptap's Link autolinks whole
 * URLs), nothing in these six columns is meant to point inside the app, and
 * "refuse what we cannot classify" is the right default in an allowlist. A
 * dropped href renders as the link TEXT, never as a dead or hostile link.
 */
const SAFE_HREF = /^(?:https?:|mailto:)/i;

/**
 * Sanitise one rich-text value in the browser.
 *
 * Returns HTML safe to hand to `dangerouslySetInnerHTML`. Empty in, empty out —
 * and empty OUT for anything that reduces to nothing, so a caller can use the
 * result as its own "is there anything here" test exactly as `RichText` does.
 */
export function sanitizeRichTextInBrowser(dirty: string | null | undefined): string {
  if (!dirty) return "";

  /*
   * ⚠️ THE SERVER PASS OF A `"use client"` COMPONENT HAS NO `DOMParser`, and
   * this page has one: React renders the client tree on the server for its
   * initial HTML before any query has resolved. In practice the values here are
   * `undefined` at that point — the data comes from a `queryFn`, which only ever
   * runs in the browser — but "in practice" is not a guarantee to build a
   * security boundary on, and a crash in an SSR pass is a 500 rather than a
   * missing paragraph.
   *
   * So the fallback is the FLATTENER, which is client-safe, has no dependency on
   * a DOM, and produces TEXT. React escapes a text node, so the fallback cannot
   * be a way past this function — it is strictly more conservative than the
   * real path, losing formatting rather than gaining permissiveness.
   */
  if (typeof DOMParser === "undefined") return escapeText(richTextToPlainText(dirty));

  const doc = new DOMParser().parseFromString(dirty, "text/html");
  const clean = doc.createElement("div");

  walk(doc.body, clean, doc);

  return clean.innerHTML;
}

/**
 * Copy `source`'s children into `target`, keeping only what is allowed.
 *
 * Everything is created through `doc` — the inert parsed document — so no node
 * from the input is ever adopted into the output tree.
 */
function walk(source: Node, target: Element, doc: Document): void {
  for (const child of Array.from(source.childNodes)) {
    // Text survives as text. React would escape it anyway; this escapes it via
    // the DOM's own serialiser, which is the same guarantee without a regex.
    if (child.nodeType === 3 /* TEXT_NODE */) {
      target.appendChild(doc.createTextNode(child.nodeValue ?? ""));
      continue;
    }

    // Comments, CDATA, processing instructions, doctypes: dropped outright.
    // None of them is anything the editor produces.
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;

    const element = child as Element;
    const tag = element.tagName.toLowerCase();

    /*
     * ⚠️ THE DROP LIST IS TESTED FIRST, AND THE ORDER IS THE WHOLE SAFETY
     * PROPERTY. It used to read `if (!ALLOWED.has(tag))` first, so the drop list
     * was only ever consulted for tags that were already disallowed — which is
     * fine exactly as long as the two sets never overlap.
     *
     * They do not overlap today. But `ALLOWED` is `RICH_TEXT_TAGS`, which lives
     * in `lib/rich-text.ts` and whose own header instructs people to add to it
     * ("If you add an extension to the editor, add its tag here in the same
     * commit") for reasons that have nothing to do with security. The day
     * `style` or `xmp` lands in that list, the old order builds
     * `doc.createElement("style")` with a copied text child, and an HTML
     * serialiser does not escape the children of a raw-text element:
     *
     *     <style></style><img src=x onerror=alert(1)></style>   ← live image
     *
     * Testing the drop list first makes that impossible from this file, and
     * `assertDisjoint` below makes it impossible to introduce silently at all.
     */
    if (DROP_WITH_CONTENT.has(tag)) continue;

    if (!ALLOWED.has(tag)) {
      // Unwrapped, not dropped: `<div><p>hi</p></div>` keeps the paragraph.
      walk(element, target, doc);
      continue;
    }

    /*
     * ⚠️ A FRESH ELEMENT, AND ONLY ATTRIBUTES NAMED BELOW. Nothing is copied
     * across, so there is no list of dangerous attributes to keep up to date —
     * `onclick`, `style`, `class`, `srcset` and everything nobody has thought of
     * are absent because they were never asked for.
     */
    const safe = doc.createElement(tag);

    if (tag === "a") {
      const href = element.getAttribute("href");
      if (href && SAFE_HREF.test(href.trim())) safe.setAttribute("href", href.trim());

      /*
       * The same values `sanitizeRichText`'s `simpleTransform` writes, and set
       * unconditionally for the same reason: a stored `target="_self"` must not
       * survive merely by being on an allowlist. `rel` without `noopener` on a
       * `_blank` link is the whole point of having a `rel` here.
       */
      safe.setAttribute("rel", "noopener noreferrer nofollow");
      safe.setAttribute("target", "_blank");
    }

    walk(element, safe, doc);
    target.appendChild(safe);
  }
}

/** The five characters an HTML escaper emits. Only reached on the no-DOM path. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

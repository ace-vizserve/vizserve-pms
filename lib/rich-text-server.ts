import sanitizeHtml from "sanitize-html";

import { isTaskImageSrc, MENTION_ATTR, RICH_TEXT_TAGS } from "@/lib/rich-text";

/**
 * P7-71 — the shape of a mention's id, and the only one the sanitiser keeps.
 *
 * ⚠️ ANCHORED AT BOTH ENDS, exactly like `TASK_IMAGE_SRC` next door and for the
 * same reason: this is the value the notify trigger casts to `uuid`, so
 * anything that is not one is not a mention. Validating it here rather than
 * trusting it there means a hand-written body can hold nonsense and the worst
 * that happens is a word loses its highlight.
 */
const MENTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      /*
       * P7-67 — `src` and `alt`, and NOTHING ELSE. No `width`, no `height`, no
       * `style`: the stylesheet sizes these (`.rich-text img` in globals.css),
       * and an author-supplied width is how one pasted screenshot breaks the
       * column every other comment sits in. No `srcset` either — it is a second
       * place a URL can hide, and `exclusiveFilter` below only reads `src`.
       */
      /*
       * ⚠️ `loading` AND `decoding` MUST BE LISTED even though `transformTags`
       * below is what sets them — the same trap as `rel`/`target` on `a`, for
       * the same reason: attributes are filtered AFTER transforming.
       *
       * `width`, `height` and `data-orientation` are the measurements the
       * server took (`lib/image-size.ts`). They are on the allowlist but their
       * VALUES are rewritten by the transform below, so nothing a body claims
       * about them survives unexamined. No `style`: a pasted screenshot
       * carrying `position:fixed` is a comment that escapes its own card.
       */
      img: ["src", "alt", "loading", "decoding", "width", "height", "data-orientation"],
      /*
       * P7-71 — ONE ATTRIBUTE, AND NOTHING ELSE, EVER.
       *
       * `span` is the only tag on the allowlist with no meaning of its own (see
       * `RICH_TEXT_TAGS`), so it is admitted for the single purpose of carrying
       * a mention's user id. No `class`: a user-supplied class on an element
       * this app renders with `dangerouslySetInnerHTML` is every utility in
       * `globals.css` in the hands of anybody who can type into a comment box.
       * No `style` either, for the shorter version of the same reason. The
       * stylesheet selects on the data attribute instead.
       */
      span: [MENTION_ATTR],
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
      /*
       * ⚠️ NOT `simpleTransform`, BECAUSE THREE OF THESE ATTRIBUTES ARE VALUES
       * RATHER THAN CONSTANTS. `loading` and `decoding` are the same on every
       * image — lazy, so a thread with a dozen screenshots does not block its
       * own first paint — but the dimensions come out of the body and have to
       * be read before they are believed.
       *
       * A NUMBER OR NOTHING. `width="2560"` is useful: the browser derives an
       * intrinsic aspect ratio from the pair and reserves the right box before
       * the bytes arrive, so a thread does not jolt as it loads. `width="100%"`
       * or `width="expression(...)"` is not, so anything that is not a plain
       * run of digits is dropped rather than corrected. The CSS caps in
       * `globals.css` still bound the DISPLAYED size either way — these
       * attributes cannot make a picture wider than its column.
       */
      img: (tagName, attribs) => {
        const kept: sanitizeHtml.Attributes = {
          src: attribs.src ?? "",
          loading: "lazy",
          decoding: "async",
        };

        if (attribs.alt) kept.alt = attribs.alt;

        for (const dimension of ["width", "height"] as const) {
          const value = attribs[dimension];
          // Four digits and change: 99999 is past any real screenshot, and an
          // unbounded run of digits is a number nobody should be laying out.
          if (value && /^[0-9]{1,5}$/.test(value)) kept[dimension] = value;
        }

        // A closed set, so the stylesheet's selectors are the only ones that
        // can match. An unknown value is dropped and the image takes the
        // fallback cap.
        if (["landscape", "portrait", "square"].includes(attribs["data-orientation"] ?? "")) {
          kept["data-orientation"] = attribs["data-orientation"]!;
        }

        return { tagName, attribs: kept };
      },

      /*
       * P7-71 — A SPAN IS A MENTION OR IT IS NOTHING.
       *
       * The allowlist above already limits the attribute to `data-mention-id`;
       * this checks its VALUE, because the trigger downstream casts it to
       * `uuid` and because a mention that is not a real id is not a mention.
       *
       * ⚠️ A FAILING SPAN KEEPS ITS TEXT AND LOSES ITS MEANING, rather than
       * being removed. It cannot go through `exclusiveFilter` like the `img`
       * guard does — that takes the element's CONTENTS with it, and a span's
       * contents are the words somebody wrote. So a span with a bad id comes
       * out bare: no attribute, so no stylesheet match, so it reads as the
       * plain text it always was. Nothing is lost except the highlight, and
       * nothing is notified, which is the correct outcome for an id the
       * database was never going to recognise anyway.
       */
      span: (tagName, attribs) => {
        const id = attribs[MENTION_ATTR];
        const kept: sanitizeHtml.Attributes = {};
        if (MENTION_ID.test(id ?? "")) kept[MENTION_ATTR] = id!;
        return { tagName, attribs: kept };
      },
    },
    /*
     * ⚠️ THE `img` GUARD, and the reason `img` can be on the allowlist at all.
     *
     * sanitize-html's scheme filtering applies to attributes you nominate, and
     * nominating `src` would still admit any absolute `https://` URL — a
     * tracking pixel, a hotlink, an image that disappears when somebody else's
     * server does. This app serves inline images from exactly one route, so the
     * rule is an allowlist of one shape rather than a list of the schemes
     * somebody had already thought of. Everything else is dropped, `data:`
     * URIs included: an editor that inlined base64 into a text column is the
     * thing P7-56 refused, and this is what keeps refusing it now that the tag
     * is permitted.
     *
     * `exclusiveFilter` rather than a transform because `img` is a void element
     * with no text, so returning `false` removes it outright instead of leaving
     * a src-less box behind.
     */
    exclusiveFilter: (frame) => frame.tag === "img" && !isTaskImageSrc(frame.attribs.src),
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

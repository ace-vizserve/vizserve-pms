/**
 * P7-56 — the rules for the six rich-text columns, minus the sanitiser.
 *
 * Six columns hold prose people write paragraphs into — a QA resolution, a task
 * brief, a comment, the reason on an internal request. They used to be plain
 * text rendered with `whitespace-pre-wrap`; they now hold a small, fixed subset
 * of HTML produced by `components/ui/rich-text-editor.tsx`.
 *
 * ⚠️ NOTHING HERE MAKES ANYTHING SAFE TO RENDER. That is `sanitizeRichText` in
 * `lib/rich-text-server.ts`, which is a separate module precisely so its Node
 * dependency stays out of the client bundle. This file is client-safe: zod
 * schemas import it, and those schemas are imported by client components.
 *
 * ⚠️ THE ALLOWLIST AND THE EDITOR'S SCHEMA ARE ONE DECISION. If you add an
 * extension to the editor, add its tag here in the same commit — a mark the
 * toolbar offers and the sanitiser strips is a formatting button that silently
 * does nothing the moment the page reloads.
 */

/**
 * Everything the editor can produce, and nothing else.
 *
 * ⚠️ `h3` AND `h4`, NEVER `h1`/`h2`. These fields render inside cards on pages
 * that already own their heading hierarchy — the page title is the `h1`, the
 * card title is around `h2`. A comment containing an `h1` would outrank the page
 * itself in a screen reader's document outline. The editor offers exactly two
 * levels and maps them here.
 *
 * `img` IS ALLOWED, AND ONLY EVER POINTING AT OUR OWN FILE ROUTE (P7-67). The
 * earlier rule here said no images at all, on the grounds that this app has a
 * real attachment system and an editor that inlined base64 would quietly
 * duplicate it into a text column. That second half still stands and is now
 * enforced rather than asserted: `sanitizeRichText` drops any `img` whose `src`
 * is not `/api/task-images/<uuid>`, so a `data:` URI, a tracking pixel and a
 * hotlink to somebody else's server are all removed — the bytes have to have
 * gone through the uploader, which measured and sniffed them, and the row that
 * describes them is an ordinary task attachment.
 *
 * No `table`: unusable at the width these fields render.
 */
export const RICH_TEXT_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "s",
  "code",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h3",
  "h4",
  "a",
  "img",
] as const;

/**
 * P7-67 — where an inline image's bytes are served from, and the only `src` the
 * sanitiser will keep.
 *
 * ⚠️ A ROUTE, NOT A SIGNED URL, and the difference is the whole design. The
 * bucket is private, so the bytes are only reachable through a signature that
 * expires in a minute — and a comment body is stored for years. Writing a
 * signed URL into the body would produce an image that renders once, for the
 * person who pasted it, and is a broken icon by the time anybody replies.
 *
 * So the body carries a STABLE reference to the attachment row, and
 * `app/api/task-images/[attachmentId]/route.ts` mints a fresh signature per
 * viewer, after RLS has said that viewer may see the task. The authorisation
 * happens at read time, which is the only time it can be honest.
 */
export const TASK_IMAGE_PATH = "/api/task-images/";

/** The `src` to write into a comment body for an uploaded attachment. */
export function taskImageSrc(attachmentId: string): string {
  return `${TASK_IMAGE_PATH}${attachmentId}`;
}

/**
 * Is this `src` one of ours?
 *
 * ⚠️ ANCHORED AT BOTH ENDS, AND A UUID RATHER THAN `.+`. This is the check that
 * stands between a comment box and stored `<img src="data:text/html;…">`, so it
 * describes exactly what it accepts instead of describing what it rejects. A
 * protocol-relative `//evil.example/x` fails it because it does not start with
 * the prefix; `/api/task-images/../../x` fails it because `..` is not a uuid.
 */
const TASK_IMAGE_SRC = /^\/api\/task-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTaskImageSrc(src: string | null | undefined): boolean {
  return typeof src === "string" && TASK_IMAGE_SRC.test(src);
}

/**
 * Every task image a body references, by attachment id.
 *
 * ⚠️ THIS IS WHAT DECIDES WHETHER A STORED FILE IS STILL IN USE. An image
 * removed from a comment leaves its row and its bytes behind — the comment is
 * the only thing that ever referenced them — so `sweepCommentImages` reads the
 * bodies, reads this, and deletes the difference. Loosen the pattern and it
 * will "find" references that are not there and leave real orphans; tighten it
 * past what `taskImageSrc` writes and it will delete images that ARE on screen.
 * The two must describe the same string, which is why they live together.
 *
 * Deliberately reads the raw markup rather than parsing it: this runs on the
 * server, on a column, with no DOM, and a body that somebody hand-edited badly
 * enough to defeat a regex is not one to be deleting files on the strength of.
 * Deduplicated — the same picture twice in one comment is one file.
 */
export function taskImageIds(html: string | null | undefined): string[] {
  if (!html) return [];

  const found = html.matchAll(
    /\/api\/task-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
  );

  return [...new Set([...found].map((match) => match[1]!.toLowerCase()))];
}

/**
 * Turn the escaped entities back into the characters somebody typed.
 *
 * A fixed set rather than a general decoder — these six are what an HTML
 * escaper emits, and the output of this file is only ever read as text.
 * `&amp;` is decoded LAST so that `&amp;lt;` becomes `&lt;` rather than `<`.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Flatten to plain text.
 *
 * ⚠️ ONE FUNCTION, THREE CONSUMERS, AND THAT IS THE POINT. Client-facing email
 * needs it because `lib/email/layout.ts` escapes every value it interpolates,
 * so raw markup would arrive in an inbox as visible `<strong>` tags. Every
 * truncated list cell needs it because `line-clamp` counts LINES and cannot
 * clamp block-level HTML — a `<ul>` in a board card would blow the card open.
 * And every length check needs it, because the caps were written about prose.
 *
 * Three copies of this would drift, and the drift would be invisible: the email
 * and the list preview of the same comment would simply disagree.
 *
 * ⚠️ A REGEX, NOT THE SANITISER, AND THAT IS SAFE HERE — but only here. This
 * produces TEXT, which every destination renders as a text node or through an
 * HTML escaper, so a tag this misses is displayed rather than executed. It
 * would be worthless for producing HTML. If you ever want to render the result
 * as markup, you want `sanitizeRichText` instead, and you want it on the server.
 */
export function richTextToPlainText(html: string | null | undefined): string {
  if (!html) return "";

  const text = html
    /*
     * A list item keeps its marker — without it a three-point resolution
     * reaches the client's inbox as one run-on sentence.
     *
     * ⚠️ `</li>` IS DELIBERATELY ABSENT from the closing-tag list below. The
     * opening `<li>` already supplies the newline, and adding a second put a
     * blank line between every bullet.
     */
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    /*
     * P7-67 — AN IMAGE LEAVES A WORD BEHIND. A comment that is one pasted
     * screenshot and nothing else flattens to the empty string otherwise, and
     * three things break at once on a body nobody would call empty:
     * `isRichTextEmpty` below refuses to let it be posted at all, the list
     * preview draws a blank cell, and the client email arrives with a silent
     * gap where the picture was.
     *
     * The alt text when there is one, because "Screenshot 2026-09-16.png" is
     * more use in an inbox than the bare word "image".
     */
    .replace(/<img[^>]*\balt="([^"]+)"[^>]*>/gi, "[$1]")
    .replace(/<img[^>]*>/gi, "[image]")
    .replace(/<\/(p|div|h[1-6]|blockquote|ul|ol)>/gi, "\n")
    // Drop `script` and `style` WITH their bodies before the general strip
    // below, or an inert `<script>` would contribute its source as text.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "");

  return (
    decodeEntities(text)
      /*
       * ⚠️ COLLAPSE TO A SINGLE NEWLINE. Nesting produces runs that mean
       * nothing — `<blockquote><p>x</p></blockquote>` closes two blocks and
       * would leave a blank line the author never typed. One newline per block
       * boundary is predictable, and these are short prose fields rather than
       * documents, so no structure is lost.
       */
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim()
  );
}

/**
 * Is there anything actually written here?
 *
 * ⚠️ AN EMPTY TIPTAP DOCUMENT IS `<p></p>`, WHICH IS SEVEN CHARACTERS. Without
 * this, `z.string().min(1)` passes on a field nobody typed in and a required
 * resolution stops being required. The mirror bug is worse: a `.min(5)` measured
 * on markup is satisfied by an empty document, so the rule that says "explain
 * yourself" is passed by saying nothing at all.
 */
export function isRichTextEmpty(html: string | null | undefined): boolean {
  return richTextToPlainText(html).length === 0;
}

/**
 * The length that matters.
 *
 * `<p><strong>ok</strong></p>` is 26 characters of markup and 2 of prose. Every
 * cap on these columns was written about prose — 2000 characters of a reason,
 * 4000 of a comment — so measuring markup would silently cut the real limit to a
 * fraction of itself, and "why will this not save" begins.
 */
export function richTextLength(html: string | null | undefined): number {
  return richTextToPlainText(html).length;
}

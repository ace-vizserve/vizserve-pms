import { describe, expect, it } from "vitest";

import {
  isRichTextEmpty,
  isTaskImageSrc,
  richTextLength,
  richTextToPlainText,
  taskImageIds,
  taskImageSrc,
} from "@/lib/rich-text";
import { sanitizeRichText } from "@/lib/rich-text-server";
import { taskCommentSchema, taskPatchSchema } from "@/lib/schemas/tasks";

/**
 * P7-56 — the rich-text boundary.
 *
 * These six columns are the first place this app stores HTML it did not write
 * itself, and `sanitizeRichText` is the only thing between that and a
 * `dangerouslySetInnerHTML`. Everything below is a pure function, so unlike the
 * SQL in this repo it genuinely IS proven here rather than merely described.
 */

describe("sanitizeRichText — the guard", () => {
  it("strips a script tag and its contents", () => {
    const out = sanitizeRichText("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("hi");
  });

  it("drops a javascript: href but keeps the link text", () => {
    // ⚠️ The one place a user-supplied string reaches an attribute. Losing the
    // href and keeping the words is right — the sentence still reads.
    const out = sanitizeRichText('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript");
    expect(out).toContain("click");
  });

  it("drops event handler attributes", () => {
    const out = sanitizeRichText('<p onclick="alert(1)">hi</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("hi");
  });

  it("neutralises the classic img/onerror payload", () => {
    const out = sanitizeRichText('<img src=x onerror=alert(1)>');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<img");
  });

  it("strips style and class, which carry no meaning here", () => {
    // What a Google Docs paste is mostly made of.
    const out = sanitizeRichText('<p style="color:red" class="c1">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  it("keeps every tag the editor can produce", () => {
    const rich =
      "<h3>Head</h3><h4>Sub</h4><p><strong>b</strong><em>i</em><s>s</s><code>c</code></p>" +
      "<ul><li>one</li></ul><ol><li>two</li></ol><blockquote><p>q</p></blockquote>";
    const out = sanitizeRichText(rich);

    for (const tag of ["h3", "h4", "strong", "em", "s", "code", "ul", "ol", "li", "blockquote"]) {
      expect(out).toContain(`<${tag}>`);
    }
  });

  it("forces rel and target onto a surviving link", () => {
    const out = sanitizeRichText('<a href="https://example.com">x</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("overrides a stored target rather than trusting it", () => {
    const out = sanitizeRichText('<a href="https://example.com" target="_self">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain('target="_self"');
  });

  it("allows mailto, http and https", () => {
    for (const href of ["https://a.test", "http://a.test", "mailto:a@b.test"]) {
      expect(sanitizeRichText(`<a href="${href}">x</a>`)).toContain(href);
    }
  });

  it("leaves a plain-text row untouched", () => {
    // ⚠️ The property that lets this ship with no backfill. Every existing row
    // in all six columns is plain text and must survive verbatim.
    const plain = "Fixed the header.\nRe-exported the logo.";
    expect(sanitizeRichText(plain)).toBe(plain);
  });

  it("escapes a stray angle bracket rather than eating the rest of the line", () => {
    // Somebody wrote "width a < b" in a resolution in 2026. It comes back as
    // the entity, which renders as `<` and decodes back to `<` — the round trip
    // is what matters, not the storage form.
    const out = sanitizeRichText("width a < b and more text");
    expect(richTextToPlainText(out)).toBe("width a < b and more text");
  });

  it("returns an empty string for null and undefined", () => {
    expect(sanitizeRichText(null)).toBe("");
    expect(sanitizeRichText(undefined)).toBe("");
  });
});

describe("richTextToPlainText — the flattener", () => {
  it("turns paragraphs into newlines", () => {
    expect(richTextToPlainText("<p>one</p><p>two</p>")).toBe("one\ntwo");
  });

  it("gives list items a bullet", () => {
    // Without this a three-point resolution reaches the client's inbox as one
    // run-on sentence.
    expect(richTextToPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("• one\n• two");
  });

  it("keeps numbered-list items on their own lines", () => {
    expect(richTextToPlainText("<ol><li>first</li><li>second</li></ol>")).toBe(
      "• first\n• second",
    );
  });

  it("converts <br> to a newline", () => {
    expect(richTextToPlainText("<p>one<br>two</p>")).toBe("one\ntwo");
  });

  it("decodes entities to what somebody actually typed", () => {
    expect(richTextToPlainText("<p>Tom &amp; Jerry &lt;3</p>")).toBe("Tom & Jerry <3");
  });

  it("drops marks but keeps their text", () => {
    expect(richTextToPlainText("<p><strong>bold</strong> and <em>italic</em></p>")).toBe(
      "bold and italic",
    );
  });

  it("collapses the blank-line runs the block replacements create", () => {
    const out = richTextToPlainText("<blockquote><p>quoted</p></blockquote><p>after</p>");
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toBe("quoted\nafter");
  });

  it("is a no-op on plain text", () => {
    expect(richTextToPlainText("just words")).toBe("just words");
  });

  it("flattens a heading into its own line", () => {
    expect(richTextToPlainText("<h3>Title</h3><p>body</p>")).toBe("Title\nbody");
  });
});

describe("isRichTextEmpty — what 'required' means now", () => {
  it("treats an empty TipTap document as empty", () => {
    // ⚠️ `<p></p>` is seven characters. Without this every `.min(1)` on these
    // columns passes on a field nobody typed in.
    expect(isRichTextEmpty("<p></p>")).toBe(true);
    expect(isRichTextEmpty("<p><br></p>")).toBe(true);
  });

  it("treats whitespace-only content as empty", () => {
    expect(isRichTextEmpty("<p>   </p>")).toBe(true);
  });

  it("treats an empty string, null and undefined as empty", () => {
    expect(isRichTextEmpty("")).toBe(true);
    expect(isRichTextEmpty(null)).toBe(true);
    expect(isRichTextEmpty(undefined)).toBe(true);
  });

  it("does not treat real content as empty", () => {
    expect(isRichTextEmpty("<p>a</p>")).toBe(false);
    expect(isRichTextEmpty("plain")).toBe(false);
  });
});

describe("richTextLength — caps measured on prose, not markup", () => {
  it("counts the words, not the tags", () => {
    // ⚠️ 26 characters of markup, 2 of prose. Measuring markup would cut every
    // 2000-character cap in this app to a few hundred real characters.
    expect(richTextLength("<p><strong>ok</strong></p>")).toBe(2);
  });

  it("makes a five-character minimum reachable", () => {
    expect(richTextLength("<p>hello</p>")).toBe(5);
  });

  it("counts an empty document as zero", () => {
    expect(richTextLength("<p></p>")).toBe(0);
  });
});

/**
 * P7-57 — THE RESOLUTION GATE, WHICH THE EMPTY DOCUMENT NEARLY DEFEATED.
 *
 * `vizserve_pms_transition_task` refuses the move to FOR_QA when
 * `length(btrim(resolution)) = 0`. An empty TipTap editor serialises to
 * `<p></p>` — seven characters that check reads as content — so making the
 * resolution rich would have opened the gate to a resolution nobody wrote,
 * with the box plainly empty on screen.
 *
 * Two things close it, and both are asserted here because either one alone is
 * a silent hole: the schema normalises the empty document to `""` before the
 * write, and the client gate asks `isRichTextEmpty` rather than trimming.
 */
describe("the empty document cannot open the QA gate", () => {
  it("normalises an empty editor to the empty string on write", () => {
    const parsed = taskPatchSchema.parse({ resolution: "<p></p>" });

    // Not `<p></p>`: `actions.ts` writes `resolution || null`, and seven
    // characters of markup would sail past that and reach the column.
    expect(parsed.resolution).toBe("");
  });

  it("normalises the shapes an editor actually produces when emptied", () => {
    for (const empty of ["<p></p>", "<p><br></p>", "<p>   </p>", ""]) {
      expect(taskPatchSchema.parse({ resolution: empty }).resolution).toBe("");
      expect(isRichTextEmpty(empty)).toBe(true);
    }
  });

  it("leaves a real resolution untouched, markup and all", () => {
    const written = "<p>Rebuilt the deck and <strong>reshot</strong> slide 4.</p>";
    expect(taskPatchSchema.parse({ resolution: written }).resolution).toBe(written);
    expect(isRichTextEmpty(written)).toBe(false);
  });

  it("measures the comment cap on prose, so markup cannot exhaust it", () => {
    // 4000 is the cap. A document whose PROSE is 4000 characters passes even
    // though the markup is longer; measuring the markup would refuse it.
    const prose = "a".repeat(4000);
    expect(() => taskCommentSchema.parse({ body: `<p><em>${prose}</em></p>` })).not.toThrow();
    expect(() => taskCommentSchema.parse({ body: `<p>${"a".repeat(4001)}</p>` })).toThrow();
  });

  it("refuses a comment that is only an empty document", () => {
    expect(() => taskCommentSchema.parse({ body: "<p></p>" })).toThrow();
  });
});


/**
 * P7-67 — images in a comment.
 *
 * The tag is on the allowlist now, so the interesting question moved: it is no
 * longer "is `img` allowed" but "is THIS `img` one of ours". Everything below
 * is that question, asked in the ways somebody would ask it in anger.
 */
describe("sanitizeRichText — inline images", () => {
  const id = "3f1c9a52-7b0e-4d61-9a2c-8e5d4b6f1a07";
  const ours = `<img src="${taskImageSrc(id)}" alt="Screenshot.png">`;

  it("keeps an image served by our own route", () => {
    const out = sanitizeRichText(`<p>see this</p>${ours}`);
    expect(out).toContain(taskImageSrc(id));
    expect(out).toContain('alt="Screenshot.png"');
  });

  it("adds lazy loading, and keeps it — the attribute is allowed as well as set", () => {
    // The trap this repo has hit once already on `rel`/`target`: sanitize-html
    // filters attributes AFTER transforming, so an attribute the transform adds
    // and the allowlist omits is silently discarded.
    const out = sanitizeRichText(ours);
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
  });

  it("drops a base64 data URI outright", () => {
    // The whole reason P7-56 banned images. A `data:` image is megabytes of a
    // text column, and it would arrive by paste without anybody choosing it.
    const out = sanitizeRichText(
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="x">',
    );
    expect(out).not.toContain("data:");
    expect(out).not.toContain("<img");
  });

  it("drops a hotlink to somebody else's server", () => {
    const out = sanitizeRichText('<p>hi</p><img src="https://evil.example/pixel.png">');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<img");
    // The prose around it survives — dropping the tag is not dropping the
    // comment.
    expect(out).toContain("hi");
  });

  it("drops a protocol-relative src, which starts with neither scheme nor slash-api", () => {
    const out = sanitizeRichText('<img src="//evil.example/pixel.png">');
    expect(out).not.toContain("evil.example");
  });

  it("drops a path that only looks like ours", () => {
    for (const src of [
      "/api/task-images/", // no id
      "/api/task-images/not-a-uuid",
      "/api/task-images/../../etc/passwd",
      `/api/task-images/${id}/../../x`,
      `https://evil.example/api/task-images/${id}`,
      `/api/task-images/${id}?next=https://evil.example`,
    ]) {
      expect(isTaskImageSrc(src)).toBe(false);
      expect(sanitizeRichText(`<img src="${src}">`)).not.toContain("<img");
    }
  });

  it("keeps numeric width and height — they reserve the box before the bytes land", () => {
    const out = sanitizeRichText(
      `<img src="${taskImageSrc(id)}" width="2560" height="1440" data-orientation="landscape">`,
    );
    expect(out).toContain('width="2560"');
    expect(out).toContain('height="1440"');
    expect(out).toContain('data-orientation="landscape"');
  });

  it("drops a width that is not a plain number, and style outright", () => {
    // The CSS caps bound the DISPLAYED size whatever these say, so this is not
    // the thing standing between a comment and a broken column — but an
    // attribute that is not a number is not a measurement, and `style` is how
    // one comment escapes its own card.
    for (const attribute of [
      'width="100%"',
      'width="expression(alert(1))"',
      'width="-40"',
      'width="1e6"',
      'width="999999"',
      'style="position:fixed;inset:0"',
    ]) {
      const out = sanitizeRichText(`<img src="${taskImageSrc(id)}" ${attribute}>`);
      expect(out).toContain(taskImageSrc(id));
      expect(out).not.toContain("=\"100%\"");
      expect(out).not.toContain("expression");
      expect(out).not.toContain("style");
      expect(out).not.toContain("999999");
    }
  });

  it("drops an orientation outside the closed set", () => {
    // The stylesheet has a rule per value. An unknown one would match nothing
    // and silently take the fallback cap, so it is removed rather than stored.
    const out = sanitizeRichText(`<img src="${taskImageSrc(id)}" data-orientation="diagonal">`);
    expect(out).not.toContain("diagonal");
    expect(out).toContain(taskImageSrc(id));
  });

  it("does not let stored markup declare itself a button", () => {
    // ⚠️ THE LIGHTBOX ADDS `role` AND `tabindex` IN `comment-body.tsx`, where
    // the handler is. A body that arrives already carrying them would announce
    // itself as a control on `<RichText>` too — a server component with nothing
    // listening.
    const out = sanitizeRichText(
      `<img src="${taskImageSrc(id)}" role="button" tabindex="0" onclick="alert(1)">`,
    );
    expect(out).not.toContain("role");
    expect(out).not.toContain("tabindex");
    expect(out).not.toContain("onclick");
  });

  it("still neutralises onerror on an image it otherwise keeps", () => {
    const out = sanitizeRichText(`<img src="${taskImageSrc(id)}" onerror="alert(1)">`);
    expect(out).not.toContain("onerror");
    expect(out).toContain(taskImageSrc(id));
  });
});

describe("richTextToPlainText — images", () => {
  const id = "3f1c9a52-7b0e-4d61-9a2c-8e5d4b6f1a07";

  it("prints the alt text, so an emailed comment is not silently missing a picture", () => {
    const flat = richTextToPlainText(
      `<p>Like this:</p><img src="${taskImageSrc(id)}" alt="Screenshot.png">`,
    );
    expect(flat).toContain("Like this:");
    expect(flat).toContain("[Screenshot.png]");
  });

  it("falls back to the word image when there is no alt", () => {
    expect(richTextToPlainText(`<img src="${taskImageSrc(id)}">`)).toBe("[image]");
  });

  it("does not call a comment that is only a screenshot empty", () => {
    // ⚠️ THE BUG THIS EXISTS TO PREVENT. Flattening to "" would make
    // `isRichTextEmpty` true, the Comment button stay disabled, and a perfectly
    // ordinary "here, look" impossible to post.
    const body = `<img src="${taskImageSrc(id)}" alt="Screenshot.png">`;
    expect(isRichTextEmpty(body)).toBe(false);
    expect(richTextLength(body)).toBeGreaterThan(0);
    expect(() => taskCommentSchema.parse({ body })).not.toThrow();
  });
});


/**
 * P7-67 — which files a body still needs.
 *
 * ⚠️ THIS FUNCTION DELETES THINGS. `sweepCommentImages` removes every image an
 * edited comment no longer lists, so a reference this misses is a picture that
 * disappears from a comment somebody can still see. It is the one place in the
 * rich-text layer where being too strict destroys data rather than merely
 * dropping a tag.
 */
describe("taskImageIds", () => {
  const a = "3f1c9a52-7b0e-4d61-9a2c-8e5d4b6f1a07";
  const b = "9b2d8e41-6c3f-4a52-8d1e-7f4c5a3b2e10";

  it("finds every image in a body", () => {
    const html = `<p>two</p><img src="${taskImageSrc(a)}"><img src="${taskImageSrc(b)}">`;
    expect(taskImageIds(html).sort()).toEqual([a, b].sort());
  });

  it("counts the same picture twice as one file", () => {
    const html = `<img src="${taskImageSrc(a)}"><img src="${taskImageSrc(a)}">`;
    expect(taskImageIds(html)).toEqual([a]);
  });

  it("finds it however the attribute is written", () => {
    // A body can be hand-edited, and a sanitiser run can change the quoting.
    // Being generous HERE is safe: an id found is a file kept.
    for (const html of [
      `<img src='${taskImageSrc(a)}'>`,
      `<img loading="lazy" src="${taskImageSrc(a)}" alt="x">`,
      `<img src="${taskImageSrc(a).toUpperCase()}">`,
    ]) {
      expect(taskImageIds(html)).toEqual([a]);
    }
  });

  it("is empty for a body with no pictures, and for nothing at all", () => {
    expect(taskImageIds("<p>just words</p>")).toEqual([]);
    expect(taskImageIds("")).toEqual([]);
    expect(taskImageIds(null)).toEqual([]);
  });

  it("does not report a partial or malformed id", () => {
    // Nothing here is a file to keep — and none of them is a file to delete
    // either, because a body cannot reference one it never had.
    expect(taskImageIds('<img src="/api/task-images/not-a-uuid">')).toEqual([]);
    expect(taskImageIds(`<img src="/api/task-images/${a.slice(0, 30)}">`)).toEqual([]);
  });

  it("agrees with what taskImageSrc writes — the pair that must not drift", () => {
    expect(taskImageIds(`<img src="${taskImageSrc(a)}">`)).toEqual([a]);
    expect(isTaskImageSrc(taskImageSrc(a))).toBe(true);
  });
});

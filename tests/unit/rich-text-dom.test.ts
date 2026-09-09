// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { sanitizeRichTextInBrowser } from "@/lib/rich-text-dom";

/**
 * P12-06 — the browser half of the render-side sanitiser.
 *
 * ⚠️ THIS IS A SECURITY BOUNDARY AND IT IS NEW, so it is tested against the same
 * strings `tests/unit/rich-text.test.ts` uses on `sanitizeRichText`. The two
 * implementations are different — one is `sanitize-html`, one is `DOMParser` —
 * and they share only `RICH_TEXT_TAGS`, so the pair of suites is what keeps them
 * answering the same way. If you change the allowlist, both files should move.
 *
 * WHY IT EXISTS AT ALL is argued in `lib/rich-text-dom.ts`: `/tasks/[id]` reads
 * its rows browser → PostgREST since Phase 3a, so there is no server render
 * between the column and the screen, and "sanitise where the row is read" now
 * means in the browser. The alternative was dropping the render-side pass, which
 * `components/ui/rich-text.tsx` argues against at length — the write path
 * sanitises but GUARDS nothing, because these columns are also reachable from a
 * SQL console, from `vizserve_pms_submit_request`, and from every row written
 * before P7-56 existed.
 *
 * ⚠️ `@vitest-environment jsdom` ON THE FIRST LINE. The runner's default is
 * `node` (see `vitest.config.ts`, which says component tests should get their
 * own environment rather than making every server test pay for a DOM). This
 * function reaches for `DOMParser`, so this one file opts in.
 */

describe("sanitizeRichTextInBrowser — the guard", () => {
  it("drops a script and its body", () => {
    // ⚠️ THE BODY GOES TOO. `disallowedTagsMode: "escape"` would print the alert
    // payload on the page as visible text; the server sanitiser discards, and so
    // does this.
    const out = sanitizeRichTextInBrowser("<p>hi</p><script>alert(1)</script>");
    expect(out).toContain("hi");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("script");
  });

  it("refuses a javascript: href", () => {
    const out = sanitizeRichTextInBrowser('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript");
    // The TEXT survives — a dropped href must not silently eat the words.
    expect(out).toContain("click");
  });

  it("drops every event handler attribute", () => {
    const out = sanitizeRichTextInBrowser('<p onclick="alert(1)">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  it("drops an img entirely, with its onerror", () => {
    // Not on the allowlist: this app has a real attachment system and an editor
    // that inlined base64 images would quietly duplicate it into a text column.
    const out = sanitizeRichTextInBrowser("<img src=x onerror=alert(1)>");
    expect(out).toBe("");
  });

  it("drops style and class", () => {
    const out = sanitizeRichTextInBrowser('<p style="color:red" class="c1">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  it("keeps the whole editor allowlist", () => {
    const rich =
      "<h3>Head</h3><p><strong>b</strong><em>i</em><s>s</s><code>c</code></p>" +
      "<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><h4>Sub</h4>";
    const out = sanitizeRichTextInBrowser(rich);

    for (const tag of ["h3", "h4", "strong", "em", "s", "code", "ul", "ol", "li", "blockquote"]) {
      expect(out).toContain(`<${tag}>`);
    }
  });

  it("stamps rel and target on a link, overwriting whatever was stored", () => {
    // The same `simpleTransform` values the server sanitiser writes, and set
    // unconditionally: a hostile `target="_self"` must not survive merely by
    // being on the allowlist.
    const out = sanitizeRichTextInBrowser('<a href="https://example.com" target="_self">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain("_self");
  });

  it("allows http, https and mailto and nothing else", () => {
    for (const href of ["https://example.com/x", "http://example.com/x", "mailto:a@b.com"]) {
      expect(sanitizeRichTextInBrowser(`<a href="${href}">x</a>`)).toContain(href);
    }
    for (const href of ["data:text/html,<script>1</script>", "vbscript:msgbox", "file:///etc"]) {
      expect(sanitizeRichTextInBrowser(`<a href="${href}">x</a>`)).not.toContain(href);
    }
  });

  it("unwraps a disallowed wrapper rather than eating its prose", () => {
    // ⚠️ THE DEFAULT IS UNWRAP, NOT DROP — `disallowedTagsMode: "discard"` on
    // the server keeps the children. A `<span>` around a sentence must not take
    // the sentence with it. `DROP_WITH_CONTENT` is the short list of exceptions.
    const out = sanitizeRichTextInBrowser("<div><span>kept</span></div>");
    expect(out).toBe("kept");
  });

  it("escapes a bare < in ordinary prose rather than eating the rest", () => {
    const out = sanitizeRichTextInBrowser("width a < b and more text");
    expect(out).toContain("more text");
  });

  it("returns empty for null, undefined and markup that reduces to nothing", () => {
    expect(sanitizeRichTextInBrowser(null)).toBe("");
    expect(sanitizeRichTextInBrowser(undefined)).toBe("");
    // The caller uses the empty string as its "is there anything here" test —
    // `RichTextClient` renders null on it, exactly as `RichText` does.
    expect(sanitizeRichTextInBrowser("<script>alert(1)</script>")).toBe("");
  });

  it("leaves the plain-text rows written before P7-56 alone", () => {
    // Six columns were plain text until P7-56 and their line breaks are real
    // newlines rather than `<br>`. `whitespace-pre-wrap` in `RICH_TEXT_CLASS` is
    // what renders them; this must not touch them on the way through.
    const plain = "Line one\nLine two";
    expect(sanitizeRichTextInBrowser(plain)).toBe(plain);
  });
});

/**
 * ⚠️ THE ADVERSARIAL HALF. The suite above asserts the happy path and the
 * obvious `onclick`; a security review pointed out that every case a
 * hand-written sanitiser is actually judged on was missing, and that two of the
 * original assertions (`not.toContain("script")`) pass on an empty string.
 *
 * These are the ones that decide whether the thing works. Each is a real
 * published vector, and each asserts what the output IS rather than what it
 * lacks.
 */

/** What actually reaches `dangerouslySetInnerHTML`. */
const clean = (html: string) => sanitizeRichTextInBrowser(html);

/** No live markup, whatever else survived. */
function expectInert(out: string) {
  expect(out).not.toMatch(/<\s*(script|img|iframe|svg|math|style|xmp|template|noscript)\b/i);
  expect(out).not.toMatch(/\son[a-z]+\s*=/i);
  expect(out).not.toMatch(/javascript:/i);
}

describe("sanitizeRichTextInBrowser — scheme obfuscation", () => {
  /*
   * ⚠️ THESE ARRIVE ALREADY DECODED. `DOMParser` resolves entities before
   * `getAttribute` returns, so the guard never sees `&#106;` — it sees
   * `javascript:` and refuses it. That is why the check can be a plain prefix
   * test rather than a decoder nobody could keep correct.
   */
  const hrefs = [
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "&#0000106;avascript:alert(1)",
    "java&#09;script:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "\u0001javascript:alert(1)",
    "\u00a0javascript:alert(1)",
    "\uFEFFjavascript:alert(1)",
    "vbscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  ];

  for (const href of hrefs) {
    it(`refuses ${JSON.stringify(href.slice(0, 28))}`, () => {
      const out = clean(`<p><a href="${href}">x</a></p>`);
      expect(out).not.toMatch(/href=/i);
      expectInert(out);
    });
  }

  it("keeps an ordinary https link, so the guard is not just refusing everything", () => {
    expect(clean('<p><a href="https://vizserve.example/x">x</a></p>')).toContain(
      'href="https://vizserve.example/x"',
    );
  });
});

describe("sanitizeRichTextInBrowser — mutation XSS", () => {
  /*
   * ⚠️ THE TEST THAT MATTERS FOR A "BUILD THE OUTPUT" SANITISER. mXSS is where
   * re-parsing the serialised output yields different markup than the parse that
   * produced it. It cannot happen here because the output alphabet contains no
   * raw-text element and no namespace-shifting element — but that is an argument,
   * and this is the evidence.
   */
  const corpus = [
    '<svg><style><a id="</style><img src=1 onerror=alert(1)>">',
    "<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>",
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    "<template><img src=x onerror=alert(1)></template>",
    "<svg><foreignObject><p>hi</p><img src=x onerror=alert(1)></foreignObject></svg>",
    "<svg><ScRiPt>alert(1)</ScRiPt></svg>",
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    "<body onload=alert(1)>hi</body>",
    '<base href="javascript:alert(1)//">',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    "<form><button formaction=javascript:alert(1)>x</button></form>",
  ];

  for (const payload of corpus) {
    it(`neutralises ${payload.slice(0, 40)}`, () => {
      expectInert(clean(payload));
    });

    it(`is a fixed point for ${payload.slice(0, 40)}`, () => {
      // f(f(x)) === f(x). If a second pass changes anything, the first pass
      // emitted something whose re-parse differs from its serialisation —
      // which is mXSS by definition.
      const once = clean(payload);
      expect(clean(once)).toBe(once);
    });
  }
});

describe("sanitizeRichTextInBrowser — event handlers in any casing", () => {
  for (const attr of ["onclick", "ONCLICK", "oNeRrOr", "onmouseover", "onfocus"]) {
    it(`drops ${attr}`, () => {
      const out = clean(`<p ${attr}="alert(1)">hi</p>`);
      expect(out).toBe("<p>hi</p>");
    });
  }
});

describe("sanitizeRichTextInBrowser — raw-text containers go with their content", () => {
  /*
   * `xmp` is the one this suite was missing, and it is the one the ordering fix
   * in `walk` exists for: a raw-text element's children are NOT escaped by a
   * serialiser, so it must never be reachable with a copied text child.
   */
  for (const tag of ["script", "style", "xmp", "noscript", "iframe", "template", "title"]) {
    it(`drops <${tag}> and everything inside it`, () => {
      const out = clean(`<p>before</p><${tag}>alert(1)</${tag}><p>after</p>`);
      expect(out).toBe("<p>before</p><p>after</p>");
    });
  }

  it("unwraps an unknown tag but keeps its prose", () => {
    // The default is the other way round from the drop list, and both matter.
    expect(clean("<div><p>hi</p></div>")).toBe("<p>hi</p>");
  });
});

describe("sanitizeRichTextInBrowser — the no-DOM fallback", () => {
  /*
   * ⚠️ AN UNTESTED BRANCH OF A SECURITY BOUNDARY, until now. It is unreachable
   * on this route today (there is no `HydrationBoundary`, so every query is
   * pending on the server pass and no rich text renders) — which is exactly why
   * it would rot unnoticed the day that changes.
   */
  it("escapes to plain text when DOMParser does not exist", () => {
    const real = globalThis.DOMParser;
    // @ts-expect-error — deliberately removing a global to take the other branch.
    delete globalThis.DOMParser;
    try {
      const out = sanitizeRichTextInBrowser("<p>hi <img src=x onerror=alert(1)></p>");
      expectInert(out);
      expect(out).not.toContain("<p>");
      expect(out).toContain("hi");
    } finally {
      globalThis.DOMParser = real;
    }
  });
});

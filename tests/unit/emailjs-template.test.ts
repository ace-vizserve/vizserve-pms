import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { EmailBody } from "@/lib/email/layout";
import { emailJsTemplateParams } from "@/lib/email/transports/emailjs";

/**
 * The EmailJS template is the one artefact in this repo with NO runtime safety
 * net whatsoever.
 *
 * It lives in a web UI, it is pasted there by hand, and EmailJS renders an
 * unresolved variable as an empty string and reports no error. A typo does not
 * fail a build or throw at send time — it ships as a labelled row with a blank
 * beside it, in a client's inbox, and nothing anywhere says why.
 *
 * So the checks that would normally be a compiler's job are here instead.
 *
 * ⚠️ P8-10 RETARGETED THIS FILE RATHER THAN DELETING IT. The template stopped
 * being request-specific and became a generic `EmailBody` renderer, which made
 * the old `receivedParams`/`approvedParams` builders dead — but the reason
 * these checks exist did not change at all. If anything it grew: ONE template
 * now carries all seven emails, so one broken placeholder is seven broken
 * emails rather than two.
 */

const TEMPLATE = readFileSync(join(process.cwd(), "docs/emailjs/template.html"), "utf8");

/** The template with HTML comments removed — what EmailJS's variables live in. */
const WITHOUT_COMMENTS = TEMPLATE.replace(/<!--[\s\S]*?-->/g, "");

/**
 * A body that fills EVERY optional field, because the question these tests ask
 * is "can the template resolve everything a body can carry". A minimal body
 * would pass while leaving `quote_label` and `footnote` unchecked.
 */
const FULL_BODY: EmailBody = {
  preheader: "VB-2026-0042",
  heading: "Your work is ready to review",
  paragraphs: ["Hi Maria,", "The quarterly newsletter layout is ready for your approval."],
  facts: [
    { label: "Reference", value: "VB-2026-0042" },
    { label: "Target date", value: "5 Aug 2026" },
  ],
  quote: { label: "What was delivered", text: "Four pages, A4.\nSecond line." },
  button: { label: "Review and approve", path: "/approve/abc123" },
  footnote: "If we do not hear from you by 8 Aug 2026 this will close automatically.",
};

const ENVELOPE = { to: "maria.santos@hfse.edu.sg", subject: "Your work is ready to review" };

describe("no placeholder syntax inside HTML comments", () => {
  /**
   * The bug this exists for, and it is not hypothetical — it shipped into a
   * draft of this template and ate the whole progress trail.
   *
   * AN HTML COMMENT IS NOT A TEMPLATE COMMENT. EmailJS parses the entire file,
   * so a section marker written in a comment as an EXAMPLE opens a real block,
   * and everything down to the next matching close tag is swallowed. The
   * symptom is silent: the markup renders as literal text or vanishes, and no
   * error is raised anywhere.
   */
  it("has no placeholder braces anywhere in a comment", () => {
    const comments = TEMPLATE.match(/<!--[\s\S]*?-->/g) ?? [];
    const offenders = comments.filter((comment) => comment.includes("{{"));

    expect(
      offenders,
      "describe the syntax in prose instead — EmailJS parses comments too",
    ).toEqual([]);
  });
});

describe("section blocks are balanced", () => {
  it("closes every block it opens, in order", () => {
    const tags = [...WITHOUT_COMMENTS.matchAll(/\{\{([#^/])\s*([a-z_]+)\s*\}\}/g)];
    const stack: string[] = [];

    for (const [, kind, name] of tags) {
      if (kind === "/") {
        // An unmatched close means the block above it swallowed markup, which
        // is the same failure mode as the comment bug and just as silent.
        expect(stack.pop(), `unexpected close of ${name}`).toBe(name);
      } else {
        stack.push(name);
      }
    }

    expect(stack, "unclosed section block").toEqual([]);
  });
});

describe("every placeholder is a variable the adapter actually passes", () => {
  /**
   * ⚠️ TWO LOOPS NOW, NOT ONE. Placeholders inside the paragraphs and facts
   * sections resolve against the ITEM, not the outer bag — a name that is only
   * a top-level variable renders empty inside a loop, silently. So the loop
   * bodies are cut out before the top-level check and asserted separately.
   */
  const LOOPS = {
    paragraphs: /\{\{#\s*paragraphs\s*\}\}([\s\S]*?)\{\{\/\s*paragraphs\s*\}\}/,
    facts: /\{\{#\s*facts\s*\}\}([\s\S]*?)\{\{\/\s*facts\s*\}\}/,
  } as const;

  function topLevelPlaceholders(): string[] {
    let outside = WITHOUT_COMMENTS;

    // Strip each loop's BODY but keep its open and close markers. Removing the
    // whole match would take the section name with it, and the loop variables
    // would then read as "sent but never rendered".
    for (const pattern of Object.values(LOOPS)) {
      outside = outside.replace(pattern, (full, body: string) => full.replace(body, ""));
    }

    return [...new Set([...outside.matchAll(/\{\{[#^/]?\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
  }

  it("resolves every top-level placeholder from emailJsTemplateParams", () => {
    const params = emailJsTemplateParams(FULL_BODY, ENVELOPE);
    const missing = topLevelPlaceholders().filter((name) => !(name in params));

    expect(missing, "the template names a variable the adapter never sends").toEqual([]);
  });

  it("sends no variable the template never renders", () => {
    /*
     * The other direction, and it catches the opposite mistake: a field added
     * to `EmailBody` and mapped in the adapter but never given a place in the
     * template renders nowhere, and the content is silently dropped.
     *
     * The envelope fields are the exception — they are configured in the
     * EmailJS dashboard's own To / Reply-To / Subject boxes rather than written
     * into the body, so they legitimately have no placeholder in this file.
     */
    const ENVELOPE_FIELDS = ["to_email", "reply_to", "subject"];
    const params = emailJsTemplateParams(FULL_BODY, ENVELOPE);
    const rendered = new Set(topLevelPlaceholders());

    const unused = Object.keys(params).filter(
      (name) => !rendered.has(name) && !ENVELOPE_FIELDS.includes(name),
    );

    expect(unused, "the adapter sends a variable the template never renders").toEqual([]);
  });

  it("resolves every placeholder inside the paragraphs loop from an item", () => {
    const inner = WITHOUT_COMMENTS.match(LOOPS.paragraphs)?.[1] ?? "";
    const names = [...new Set([...inner.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
    const item = emailJsTemplateParams(FULL_BODY, ENVELOPE).paragraphs[0];

    expect(names.length, "the loop body should use its item's fields").toBeGreaterThan(0);
    expect(names.filter((name) => !(name in item))).toEqual([]);
  });

  it("resolves every placeholder inside the facts loop from an item", () => {
    const inner = WITHOUT_COMMENTS.match(LOOPS.facts)?.[1] ?? "";
    const names = [...new Set([...inner.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
    const item = emailJsTemplateParams(FULL_BODY, ENVELOPE).facts[0];

    expect(names.length, "the loop body should use its item's fields").toBeGreaterThan(0);
    expect(names.filter((name) => !(name in item))).toEqual([]);
  });
});

describe("the mapping from EmailBody", () => {
  it("wraps paragraphs as objects, because an EmailJS loop cannot read a bare string", () => {
    const params = emailJsTemplateParams(FULL_BODY, ENVELOPE);

    expect(params.paragraphs).toEqual([
      { text: "Hi Maria," },
      { text: "The quarterly newsletter layout is ready for your approval." },
    ]);
  });

  it("guards the facts table with a scalar, not the array itself", () => {
    /*
     * Wrapping the table furniture in the facts section would make it ITERATE,
     * repeating the whole table once per row. `has_facts` drives the wrapper;
     * the array drives only the rows.
     */
    const withFacts = emailJsTemplateParams(FULL_BODY, ENVELOPE);
    const without = emailJsTemplateParams({ ...FULL_BODY, facts: [] }, ENVELOPE);

    expect(withFacts.has_facts).toBe("yes");
    expect(without.has_facts).toBe("");
  });

  it("passes an empty string for every absent optional, never undefined", () => {
    /*
     * ⚠️ AN EMPTY STRING IS FALSEY TO EmailJS AND AN ABSENT KEY IS NOT
     * RELIABLY SO. Omitting the button url would leave its section opening on a
     * missing variable, and an unguarded button ships as a full-size call to
     * action pointing nowhere — a dead link in a client's inbox, which is worse
     * than no button at all.
     */
    const bare: EmailBody = { preheader: "", heading: "Hello", paragraphs: ["One line."] };
    const params = emailJsTemplateParams(bare, ENVELOPE);

    expect(params.button_url).toBe("");
    expect(params.button_label).toBe("");
    expect(params.quote_label).toBe("");
    expect(params.quote_text).toBe("");
    expect(params.footnote).toBe("");
    expect(params.has_facts).toBe("");
    expect(params.facts).toEqual([]);
  });

  it("makes the button path absolute, so the link works from an inbox", () => {
    const params = emailJsTemplateParams(FULL_BODY, ENVELOPE);

    expect(params.button_url).toMatch(/^https?:\/\/.+\/approve\/abc123$/);
  });
});

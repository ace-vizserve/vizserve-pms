#!/usr/bin/env node
/**
 * Render `template.html` with sample values, so the layout can be checked in a
 * browser without sending anything.
 *
 *   node docs/emailjs/preview.mjs
 *
 * WHY THIS EXISTS. EmailJS's own preview shows `{{reference_no}}` literally, and
 * its "Test It" button sends a real email against your monthly quota. Neither is
 * something you want in a loop while nudging padding. This substitutes the same
 * way EmailJS does and writes files you can just open.
 *
 * WHAT IT CANNOT TELL YOU: how Outlook renders it. Outlook draws through Word
 * and is the client most likely to break a layout — a browser preview is the
 * first check, not the last. Send one real test before trusting it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "template.html");

/**
 * EmailJS HTML-escapes `{{double}}` placeholders. Matching that here is the
 * whole point of the exercise: a description containing `<` or `&` renders as
 * text in the real email, and a preview that showed it as markup would send you
 * chasing a bug that does not exist — or hide one that does.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Truthiness the way EmailJS's section blocks judge it.
 *
 * An EMPTY STRING IS FALSE, and that is the case that matters: `lib/emailjs.ts`
 * deliberately passes `status_url: ""` rather than omitting the key, so a
 * missing tracking link and an absent one behave identically. If this returned
 * true for `""` the preview would show a button the real email drops.
 */
function isTruthy(value) {
  if (value === undefined || value === null || value === false) return false;
  if (value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * `{{#name}}…{{/name}}` — EmailJS's section syntax, and `{{^name}}` its inverse.
 *
 * Run BEFORE variable substitution, or the `{{#status_url}}` marker would be
 * replaced by the variable's value and the block would never be recognised.
 *
 * Non-nested, because the template has no nested sections. A nested one needs a
 * real parser rather than a regex, and would fail visibly here — the inner
 * `{{/name}}` closing the outer block — rather than silently.
 */
function renderSections(template, values) {
  return template
    .replace(/\{\{#\s*([a-z_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_match, name, body) => {
      const value = values[name];

      // AN ARRAY IS A LOOP, not a conditional — the block repeats once per
      // item, and `{{label}}` inside it resolves against THAT item rather than
      // the top-level bag. Rendering it once with the outer values, which is
      // what a conditional-only implementation would do, would draw a single
      // empty timeline row and hide the fact that the loop works.
      if (Array.isArray(value)) {
        return value.map((item) => substitute(body, item)).join("");
      }

      return isTruthy(value) ? body : "";
    })
    .replace(/\{\{\^\s*([a-z_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_match, name, body) =>
      isTruthy(values[name]) ? "" : body,
    );
}

/** `{{name}}` substitution against one bag. Shared by the loop and the page. */
function substitute(template, values) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, name) => {
    // Unresolved renders EMPTY, exactly as EmailJS does — which is the failure
    // this preview is most useful for catching. A missing variable leaves a
    // labelled row with nothing beside it and no error anywhere.
    if (!(name in values)) return "";
    return escapeHtml(values[name]);
  });
}

function render(template, values) {
  return substitute(renderSections(template, values), values);
}

/** Shared between both variants — the request itself does not change. */
/*
 * P8-10 — THE SAMPLES ARE `EmailBody` BAGS NOW, NOT REQUESTS.
 *
 * The template stopped being request-specific and became a generic renderer, so
 * these variants are shaped exactly like `emailJsTemplateParams` output in
 * `lib/email/transports/emailjs.ts`. If you change that mapping, change these —
 * `tests/unit/emailjs-template.test.ts` pins the template against the real
 * mapping, but nothing pins THIS file, because it is a dev tool.
 */

/** Paragraphs arrive as objects: an EmailJS loop has no field to read on a bare string. */
const p = (...lines) => lines.map((text) => ({ text }));

const VARIANTS = [
  {
    file: "preview-01-staff.html",
    label: "to the team, on submission",
    values: {
      to_email: "kurt.vizserve@gmail.com",
      reply_to: "maria.santos@hfse.edu.sg",
      subject: "New request — VB-2026-0042",
      preheader: "VB-2026-0042",
      heading: "New request",
      paragraphs: p(
        "Maria Santos submitted a request. It is in the queue waiting for a Team Leader.",
        "Nobody has picked this up yet.",
      ),
      has_facts: "yes",
      facts: [
        { label: "From", value: "Maria Santos · HFSE" },
        { label: "Form", value: "Design Request" },
        { label: "Target date", value: "5 Aug 2026" },
        { label: "Submitted", value: "25 Aug 2026, 2:14 PM" },
      ],
      quote_label: "What they asked for",
      // Deliberate line breaks and an ampersand: the first proves `pre-wrap` is
      // working, the second proves escaping is.
      quote_text:
        "Four pages, A4.\n\n- Cover with the new logo\n- Two feature spreads\n- Back page for events & notices\n\nBrand guide is in the shared drive.",
      button_url: "https://pms.vizserve.com/requests/42",
      button_label: "Open the request",
      footnote: "",
    },
  },
  {
    file: "preview-02-requester.html",
    label: "to the requester, on submission",
    values: {
      to_email: "maria.santos@hfse.edu.sg",
      reply_to: "hello@vizserve.com",
      subject: "We have your request — VB-2026-0042",
      preheader: "VB-2026-0042",
      heading: "Request received",
      paragraphs: p(
        "Hi Maria, thanks for sending this through.",
        "It has reached the team and somebody will review it shortly. You do not need to do anything else for now.",
      ),
      has_facts: "yes",
      facts: [
        { label: "Reference", value: "VB-2026-0042" },
        { label: "Target date", value: "5 Aug 2026" },
      ],
      quote_label: "",
      quote_text: "",
      button_url: "https://pms.vizserve.com/status/kQ7x2mVn8pLr4TzYbW1sJdHgFcAeRuNi",
      button_label: "Track this request",
      footnote: "Quote VB-2026-0042 in any reply about this request.",
    },
  },
  {
    file: "preview-03-approval.html",
    label: "to the client, at Gate 3 — the email that was never arriving",
    values: {
      to_email: "maria.santos@hfse.edu.sg",
      reply_to: "hello@vizserve.com",
      subject: "Your work is ready to review — VB-2026-0042",
      preheader: "VB-2026-0042",
      heading: "Ready for your approval",
      paragraphs: p(
        "Hi Maria, the quarterly newsletter layout is finished and has passed our internal check.",
        "Have a look and let us know — the button below approves it or asks for changes, and you do not need an account.",
      ),
      has_facts: "yes",
      facts: [
        { label: "Reference", value: "VB-2026-0042" },
        { label: "Files", value: "3 attachments" },
      ],
      quote_label: "What was delivered",
      quote_text: "Four pages, A4, with the new cover and the events & notices back page.",
      button_url: "https://pms.vizserve.com/approve/kQ7x2mVn8pLr4TzYbW1sJdHgFcAeRuNi",
      button_label: "Review and approve",
      footnote:
        "If we do not hear from you by 28 Aug 2026 this will close automatically and we will assume it is fine.",
    },
  },
  {
    /*
     * The one worth looking at hardest. Every optional value is missing, which
     * is what a caller passing `undefined` produces — EmailJS does not error, it
     * renders nothing, so the email goes out with a heading and little else.
     *
     * ⚠️ THERE MUST BE NO BUTTON HERE. Before the section wrap went into the
     * template this preview rendered a full blue call to action with an empty
     * href, which is why it is still generated.
     */
    file: "preview-04-missing-values.html",
    label: "what a forgotten variable actually looks like",
    values: {
      to_email: "kurt.vizserve@gmail.com",
      heading: "New request",
      paragraphs: p("Jun Dela Cruz submitted a request."),
      // preheader, facts, quote, button and footnote all deliberately absent.
    },
  },
];

const template = readFileSync(TEMPLATE, "utf8");

console.log("Wrote:");
for (const variant of VARIANTS) {
  const path = join(HERE, variant.file);
  const body = render(template, variant.values);

  // Wrapped the way EmailJS wraps it, on the grey ground a mail client paints —
  // otherwise every preview looks like it is missing a background.
  writeFileSync(
    path,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${variant.label}</title>
  </head>
  <body style="margin:0;padding:32px 16px;background:#f2f3f5;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:10px;">
      ${body}
    </div>
  </body>
</html>
`,
  );

  console.log(`  ${variant.file.padEnd(32)} ${variant.label}`);
}

console.log("\nOpen them in a browser. Check, in order:");
console.log("  1. the quote keeps its line breaks (pre-wrap)");
console.log("  2. '&' in the quote shows as '&', not '&amp;' (escaping)");
console.log("  3. preview-04 has NO button — an absent url must not ship an empty one");

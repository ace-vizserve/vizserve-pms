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
const request = {
  reference_no: "VB-2026-0042",
  requester_name: "Maria Santos",
  requester_email: "maria.santos@hfse.edu.sg",
  requester_org: "HFSE",
  title: "Quarterly newsletter layout",
  // Deliberate line breaks and an ampersand: the first proves `pre-wrap` is
  // working, the second proves escaping is.
  description:
    "Four pages, A4.\n\n- Cover with the new logo\n- Two feature spreads\n- Back page for events & notices\n\nBrand guide is in the shared drive.",
  form_name: "Design Request",
  target_date: "5 Aug 2026",
  submitted_at: "25 Aug 2026, 2:14 PM",
  // P7-51. The tracking page. preview-04 deliberately omits it, which is what a
  // request whose token could not be minted looks like: NO BUTTON. Before the
  // section wrap went into the template that preview rendered a full blue call
  // to action with href="" — which is why it is still generated.
  status_url: "https://pms.vizserve.com/status/kQ7x2mVn8pLr4TzYbW1sJdHgFcAeRuNi",
  progress_title: "Progress so far",
};

/**
 * The first stage, shared by every variant that has a trail at all.
 *
 * Wording mirrored from `vizserve_pms_get_request_status` — see the note on
 * `STAGE_RECEIVED` in `lib/emailjs.ts`. If these previews and the tracking page
 * ever disagree, the SQL is right and both of the others are wrong.
 */
const RECEIVED = {
  label: "Request received",
  detail: "We have your request and it is queued for review.",
  at: "25 Aug 2026, 2:14 PM",
};

const VARIANTS = [
  {
    file: "preview-01-staff.html",
    label: "to the team, on submission",
    values: {
      ...request,
      to_email: "kurt.vizserve@gmail.com",
      reply_to: request.requester_email,
      intro: `${request.requester_name} submitted a request. It is in the queue waiting for a Team Leader.`,
      status_label: "New request",
      status_note: "Nobody has picked this up yet.",
      timeline: [RECEIVED],
    },
  },
  {
    file: "preview-02-requester.html",
    label: "to the requester, on submission",
    values: {
      ...request,
      to_email: request.requester_email,
      reply_to: "hello@vizserve.com",
      intro: "Hi Maria, thanks for sending this through.",
      status_label: "Received",
      status_note:
        "It has reached the team and somebody will review it shortly. You do not need to do anything else for now.",
      timeline: [RECEIVED],
    },
  },
  {
    file: "preview-03-returned.html",
    label: "to the requester, on a status change",
    values: {
      ...request,
      to_email: request.requester_email,
      reply_to: "hello@vizserve.com",
      intro: "Hi Maria, there is an update on your request.",
      status_label: "We need a bit more before we start",
      status_note:
        "Could you confirm the page count? The brief says four pages but the outline lists five sections.\n\nSend that back and it goes straight into the queue.",
      // TWO stages, and the variant worth looking at hardest now: it is the one
      // that proves the loop repeats its body rather than rendering it once.
      timeline: [
        RECEIVED,
        {
          label: "More information needed",
          detail:
            "Could you confirm the page count? The brief says four pages but the outline lists five sections.",
          at: "26 Aug 2026, 9:02 AM",
        },
      ],
    },
  },
  {
    /*
     * The one worth looking at hardest. Every optional value is missing, which
     * is what a caller passing `undefined` produces — EmailJS does not error, it
     * renders nothing, so the email goes out with labelled rows and no values.
     * If this preview looks broken, that is the point: pass fallbacks.
     */
    file: "preview-04-missing-values.html",
    label: "what a forgotten variable actually looks like",
    values: {
      to_email: "kurt.vizserve@gmail.com",
      reference_no: "VB-2026-0043",
      requester_name: "Jun Dela Cruz",
      title: "Poster for the open day",
      status_label: "New request",
      // intro, status_note, requester_org, requester_email, form_name,
      // target_date, description and submitted_at all deliberately absent.
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
console.log("  1. the description keeps its line breaks (pre-wrap)");
console.log("  2. '&' in the description shows as '&', not '&amp;' (escaping)");
console.log("  3. preview-04 shows the blank rows a forgotten variable leaves");

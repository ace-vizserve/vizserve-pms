import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { EmailBody } from "@/lib/email/layout";
import { renderEmail } from "@/lib/email/layout";

/**
 * The email shell's previews — `docs/email/preview-*.html`, openable in a
 * browser without sending anything.
 *
 * ⚠️ IT WRITES FILES ON EVERY RUN, AND THAT IS THE POINT. The predecessor was a
 * standalone script (`node docs/emailjs/preview.mjs`) against a hand-pasted
 * template, and the whole hazard of that arrangement was drift: two copies of
 * one design, one of them regenerated only when somebody remembered. Renders
 * that happen automatically cannot go stale. Nothing here touches the network
 * or a database, the output is deterministic, and `docs/email/preview-*` is
 * gitignored — so the cost to `npm run verify` is six small files.
 *
 * WHAT IT CANNOT TELL YOU: how Outlook renders it. Outlook draws through Word
 * and is the client most likely to break a layout — a browser preview is the
 * first check, not the last. `npm run email:test` sends a real one.
 *
 * The samples below are chosen to cover the shape of `EmailBody`, not the list
 * of emails the app sends: everything optional present, a plain one, and one
 * with no call to action. A body that renders in all three renders anywhere.
 */

const OUT_DIR = join(process.cwd(), "docs", "email");

const SAMPLES: Record<string, EmailBody> = {
  /** Gate 3 — the email Phase 4's entire value rests on. Every field in use. */
  "preview-01-client-approval": {
    preheader: "COL-2026-0142 — Quarterly newsletter layout. Closes 5 Aug 2026.",
    heading: "Ready for your approval",
    // `warning` is the waiting tone. The label is the human wording the app
    // shows, never the enum behind it.
    status: { label: "Awaiting your approval", tone: "warning" },
    paragraphs: [
      "Hi Maria,",
      'We have finished "Quarterly newsletter layout" and it is ready for you to look at.',
      "If it is fine as it is, one click approves it. If something needs changing, tell us on the same page and it comes straight back to the team.",
    ],
    facts: [
      { label: "Reference", value: "COL-2026-0142" },
      { label: "Requested by", value: "Maria Santos, HFSE" },
      { label: "Closes on", value: "5 Aug 2026" },
      { label: "Attachments", value: "3 files" },
    ],
    quote: {
      label: "What we did",
      text: "Reworked the masthead to the new palette and rebuilt the two-column spread so it holds at A4.\nSwapped the cover photograph for the one you sent on Tuesday.",
    },
    button: { label: "Review and approve", path: "/approve/sample-token" },
    footnote:
      "If we do not hear from you by 5 Aug 2026, this request will be closed as completed without a response.",
  },

  /** An internal one, from the notification outbox. No quote, shorter body. */
  "preview-02-internal-assigned": {
    preheader: "COL-2026-0142 — assigned to you",
    heading: "Assigned to you",
    status: { label: "Open", tone: "neutral" },
    paragraphs: [
      "Hi Ryza,",
      'You are the PIC on "Quarterly newsletter layout". It is open and the clock is running.',
    ],
    facts: [
      { label: "Department", value: "Creative" },
      { label: "Priority", value: "High" },
      { label: "Target date", value: "5 Aug 2026" },
    ],
    button: { label: "Open the task", path: "/tasks/sample" },
  },

  /**
   * No button and no facts. The layout has to survive losing its call to
   * action — a Gate 1 return asks the client to reply, not to click.
   */
  "preview-03-returned-no-button": {
    preheader: "COL-2026-0142 — we need a little more",
    heading: "We need a little more before we start",
    status: { label: "Returned", tone: "info" },
    paragraphs: [
      "Hi Maria,",
      "Thanks for sending this over. Before the team can start, we need one more thing from you.",
    ],
    quote: {
      label: "What we need",
      text: "Could you confirm the final page count? The brief says 8 pages but the outline lists 12.",
    },
    footnote: "Reply to this email and it reaches the team directly.",
  },
};

describe("email previews", () => {
  it("renders every sample and writes it to docs/email/", () => {
    mkdirSync(OUT_DIR, { recursive: true });

    for (const [name, body] of Object.entries(SAMPLES)) {
      const { html, text } = renderEmail(body);

      // Cheap assertions, but they are the ones that would otherwise be found
      // by eye in a browser — or not at all, in an inbox.
      expect(html, `${name}: no HTML`).toContain("<!doctype html>");
      expect(html, `${name}: heading missing`).toContain(body.heading);
      expect(text, `${name}: text part carries markup`).not.toContain("<");
      // The chip is the one element that could carry state by colour alone, so
      // its label has to survive into the part that has no colour at all.
      if (body.status) {
        expect(text, `${name}: status missing from the text part`).toContain(body.status.label);
      }
      expect(html, `${name}: unresolved interpolation`).not.toContain("${");

      writeFileSync(join(OUT_DIR, `${name}.html`), html, "utf8");
      writeFileSync(join(OUT_DIR, `${name}.txt`), text, "utf8");
    }
  });

  it("renders the button only when there is a link", () => {
    const withButton = renderEmail(SAMPLES["preview-02-internal-assigned"]!).html;
    const without = renderEmail(SAMPLES["preview-03-returned-no-button"]!).html;

    expect(withButton).toContain("<a href");
    // The header lockup is an <img>, never a link, so this stays unambiguous.
    expect(without).not.toContain("<a href");
  });
});

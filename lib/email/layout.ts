import "server-only";

import { absoluteUrl, escapeHtml } from "./config";

/**
 * P0-11 — the shared email shell.
 *
 * Hand-written table HTML with inline styles, and no react-email. Email clients
 * are a decade behind browsers: Outlook renders through Word, Gmail strips
 * <style> blocks and ignores flexbox and CSS variables. Anything clever here
 * degrades to unstyled text in the client the Team Leaders actually use.
 *
 * Brand colours are the measured-safe ones from docs/12 §1. Note which is which:
 * #4359A5 carries white text at 6.54:1; #5BC0DE fails against white in BOTH
 * directions at 2.09:1 and is only ever a surface with dark ink on top.
 */

const PRIMARY = "#4359A5";
const INK = "#202020";
const MUTED = "#5f6368";
const BORDER = "#e4e6eb";
const SURFACE = "#f7f8fa";

export type EmailButton = { label: string; path: string };

export type EmailBody = {
  /** Short line under the header, e.g. the reference number. */
  preheader: string;
  heading: string;
  /** Paragraphs, rendered in order. Escaped for you. */
  paragraphs: string[];
  /** Label/value rows, e.g. "Target date — 5 Aug 2026". Escaped for you. */
  facts?: { label: string; value: string }[];
  /** Quoted block — a decision reason, a QA comment. Escaped for you. */
  quote?: { label: string; text: string };
  button?: EmailButton;
  /** Small print under the button. Escaped for you. */
  footnote?: string;
};

export function renderEmail(body: EmailBody): { html: string; text: string } {
  return { html: renderHtml(body), text: renderText(body) };
}

function renderHtml(body: EmailBody): string {
  const facts = (body.facts ?? [])
    .map(
      (fact) => `
        <tr>
          <td style="padding:6px 0;color:${MUTED};font-size:14px;width:40%;">${escapeHtml(fact.label)}</td>
          <td style="padding:6px 0;color:${INK};font-size:14px;font-weight:600;">${escapeHtml(fact.value)}</td>
        </tr>`,
    )
    .join("");

  const quote = body.quote
    ? `
      <div style="margin:24px 0;padding:16px;background:${SURFACE};border-left:3px solid ${PRIMARY};border-radius:0 6px 6px 0;">
        <div style="color:${MUTED};font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">${escapeHtml(body.quote.label)}</div>
        <div style="color:${INK};font-size:15px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(body.quote.text)}</div>
      </div>`
    : "";

  const button = body.button
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0;">
        <tr>
          <td style="border-radius:6px;background:${PRIMARY};">
            <a href="${absoluteUrl(body.button.path)}"
               style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
              ${escapeHtml(body.button.label)}
            </a>
          </td>
        </tr>
      </table>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(body.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${SURFACE};">
  <!-- Preheader: the grey line every inbox shows next to the subject. Left
       empty, clients scrape the first words of the body instead, which here
       would be the word "VizServe" repeated. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(body.preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <tr>
            <td style="background:${PRIMARY};padding:20px 28px;">
              <div style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.02em;">VizServe PMS</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 16px;color:${INK};font-size:20px;line-height:1.35;font-weight:700;">${escapeHtml(body.heading)}</h1>
              ${body.paragraphs
                .map(
                  (p) =>
                    `<p style="margin:0 0 14px;color:${INK};font-size:15px;line-height:1.6;">${escapeHtml(p)}</p>`,
                )
                .join("")}
              ${facts ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};padding:8px 0;">${facts}</table>` : ""}
              ${quote}
              ${button}
              ${body.footnote ? `<p style="margin:16px 0 0;color:${MUTED};font-size:13px;line-height:1.5;">${escapeHtml(body.footnote)}</p>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:${SURFACE};border-top:1px solid ${BORDER};">
              <p style="margin:0;color:${MUTED};font-size:12px;line-height:1.5;">
                Sent by VizServe PMS. Everything here is also in your inbox in the app.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The plain-text alternative.
 *
 * Not decoration: a message with no text/plain part scores worse with spam
 * filters, and Phase 4's whole value rests on one email reaching one client's
 * inbox rather than their spam folder.
 */
function renderText(body: EmailBody): string {
  const lines: string[] = [body.heading, "=".repeat(body.heading.length), ""];

  lines.push(...body.paragraphs, "");

  for (const fact of body.facts ?? []) {
    lines.push(`${fact.label}: ${fact.value}`);
  }
  if (body.facts?.length) lines.push("");

  if (body.quote) {
    lines.push(`${body.quote.label}:`, ...body.quote.text.split("\n").map((l) => `  ${l}`), "");
  }

  if (body.button) {
    lines.push(`${body.button.label}: ${absoluteUrl(body.button.path)}`, "");
  }

  if (body.footnote) lines.push(body.footnote, "");

  lines.push("— VizServe PMS");
  return lines.join("\n");
}

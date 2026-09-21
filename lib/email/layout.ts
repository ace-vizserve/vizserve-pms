import "server-only";

import { absoluteUrl, escapeHtml } from "./config";

/**
 * P0-11 / P8-14 — the shared email shell.
 *
 * Hand-written table HTML with inline styles, and no react-email. Email clients
 * are a decade behind browsers: Outlook renders through Word, Gmail strips
 * <style> blocks and ignores flexbox and CSS variables. Anything clever here
 * degrades to unstyled text in the client the Team Leaders actually use.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE APP'S OWN SURFACE, REBUILT IN TABLE HTML.
 *
 * Not "a template in the brand colours" — the same object a page renders. A
 * `Card` from `components/ui/card.tsx` is `rounded-lg border bg-card
 * grade-surface shadow-raised-lg`: a WHITE PANEL, graded top to bottom, with a
 * hairline border and a soft cast, sitting on the cool-grey `--background`.
 * Each of those four is reproduced below as a literal, because that combination
 * IS what this app looks like.
 *
 * ⚠️ THE FIRST CUT OF THIS FILE GOT IT BACKWARDS and the mistake is worth
 * naming, because it is the easy one to make. It took Resend's `01-Barebone`
 * demo at face value — a tinted panel sunk INTO a white card — which reads as a
 * well carved into the surface. The design system bans exactly that: "No inward
 * emboss. Ever… Things sit ON the page, never in it." Grey goes UNDER white
 * here, never inside it.
 *
 * WHAT IS STILL OWED TO BAREBONE: the outer proportions — one centred column at
 * 640px, a header rule carrying the lockup, generous panel padding. Borrowed as
 * markup, not as a dependency; the demo is JSX over `react-email` plus a
 * Tailwind config, neither of which exists here, and both of which would have to
 * render at send time.
 *
 * DELIBERATELY NOT BORROWED: the social row, the postal address, the
 * unsubscribe line and the centred hero. Everything here is transactional — an
 * unsubscribe link on the Gate 3 email invites the one client Phase 4 depends
 * on to switch it off — and every body opens "Hi Maria," above a label/value
 * table, which centred copy fights.
 * ---------------------------------------------------------------------------
 *
 * TOKENS ARE RESOLVED TO LITERALS HERE AND NOWHERE ELSE. No mail client reads a
 * CSS custom property, so `app/globals.css` cannot reach this file. Keep every
 * value in the block below — a hex at a call site is how a palette drifts one
 * email at a time.
 *
 * Contrast is measured, per the design system §1.1: white on #4359A5 is 6.54:1,
 * #556074 on white is 6.25:1, #656F82 on white is 5.06:1, and every status
 * solid clears 4.5:1 on its own subtle fill. #5BC0DE appears in no text role —
 * it is 2.09:1 against white in both directions.
 */

/* --- surface and ink ------------------------------------------------------ */

/** `--background`. The cool-grey ground a panel sits ON. */
const GROUND = "#F5F7FA";
/** `--card`. */
const CARD = "#FFFFFF";
/** `--gradient-surface`, the grade every panel carries over its fill. */
const GRADE_SURFACE = "linear-gradient(180deg,#ffffff 0%,#fafcfd 100%)";
/** `--elev-2`, what a panel casts. Ignored by Outlook, which is acceptable. */
const ELEV_PANEL =
  "0 1px 1px rgba(15,22,38,.04),0 4px 8px -2px rgba(15,22,38,.07),0 12px 20px -10px rgba(15,22,38,.12)";
/** `--elev-1`, what a control casts. */
const ELEV_CONTROL = "0 1px 1px rgba(15,22,38,.04),0 2px 4px -1px rgba(15,22,38,.06)";
/** `--border`. */
const BORDER = "#E3E7EE";
/** `--muted`. A FLAT tinted block — a fill and a border, never a shadow. */
const MUTED = "#F0F3F7";
/** `--foreground`. Headings. */
const INK = "#0F1626";
/** `--foreground-muted`, 6.25:1. Body copy. */
const INK_MUTED = "#556074";
/** `--muted-foreground`, 5.06:1. Meta, labels, footer. */
const INK_META = "#656F82";

/* --- brand ---------------------------------------------------------------- */

/** `--brand` / `--primary`. White on it at 6.54:1 — the only safe pairing. */
const PRIMARY = "#4359A5";
/** `--gradient-primary`. What a primary button is actually filled with. */
const GRADE_PRIMARY = "linear-gradient(180deg,#5169b4 0%,#3b4f94 100%)";

/**
 * `--font-sans` is Figtree, loaded by `next/font` for the app. An email cannot
 * use that pipeline, so the family is named and a system stack follows it.
 * Gmail and Outlook will ignore the webfont and land on the fallback, which is
 * the expected outcome rather than a failure — the type SCALE is doing the work
 * here, not the face.
 */
const FONT =
  "Figtree,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The white VizServe mark, on the blue tile the asset requires. */
const LOGO = "/assets/VizServeWhite.png";

/**
 * The company footer. One place, so an address change is one edit rather than
 * twelve.
 *
 * NO UNSUBSCRIBE LINK, AND THERE MUST NOT BE ONE. Everything this file renders
 * is transactional -- a request you filed, an approval waiting on you -- and an
 * unsubscribe on the Gate 3 email invites the one client Phase 4 depends on to
 * switch it off. The contact details are the opposite case: a client who cannot
 * reach a human is the reason a request gets chased by phone instead.
 */
const CONTACT = {
  copyright: "©2026 VizServe Private LTD. All rights reserved.",
  offices: [
    {
      label: "Singapore",
      lines: "Level 39 Marina Bay Financial Tower 2, 10 Marina Bay Boulevard 018983",
    },
    {
      label: "Philippines",
      lines:
        "Unit 2001 Omm-Citra Bldg. San Miguel Avenue, San Antonio, Ortigas Center, City of Pasig, 2nd District, NCR, 1605",
    },
  ],
  hours: "Monday–Friday: 09:00 AM – 06:00 PM",
  phone: "+65 9726 7986",
  email: "contactus@vizserve.com",
  /**
   * TEXT LINKS, NOT ICONS, and that is considered rather than lazy. Outlook and
   * Gmail block remote images by default, so an icon row is a row of empty
   * boxes on first open -- and unlike the lockup, which has the wordmark beside
   * it, a failed icon leaves nothing at all. Swap them for images only
   * alongside hosted PNGs in `public/assets`, and keep them readable when those
   * do not load.
   */
  social: [
    { label: "Facebook", url: "https://www.facebook.com/vizserve/" },
    { label: "LinkedIn", url: "https://www.linkedin.com/company/vizserve" },
  ],
  /**
   * The header link row, opposite the lockup.
   *
   * ⚠️ KEEP IT TO PLACES A CLIENT CAN ACTUALLY GO. The reference layout this
   * borrows from carries About / Company / Blog, which are a marketing site's
   * nav; most of this app is behind a login that a client does not have, so
   * linking it would be a dead end for the half of these emails that matter
   * most. Two links, both reachable without an account.
   */
  headerLinks: [
    { label: "Website", url: "https://www.vizserve.com" },
    { label: "Contact", url: "mailto:contactus@vizserve.com" },
  ],
} as const;

/**
 * The status tones, copied from the `TONE` map in `components/status-badge.tsx`
 * — a subtle fill, its own border, and a solid for the text and the dot.
 *
 * ⚠️ LIGHT VALUES ONLY, AND THE EMAIL OPTS OUT OF DARK MODE (see the
 * `color-scheme` meta below). A chip is the one element where a client's own
 * inversion does real damage: it recolours the fill and leaves the text, which
 * is how a status ends up unreadable in exactly the message that exists to
 * convey one.
 */
const TONE = {
  neutral: { border: BORDER, fill: MUTED, ink: INK_MUTED },
  brand: { border: "#C6D0E9", fill: "#EDF0F8", ink: "#4359A5" },
  info: { border: "#BDDAE4", fill: "#E7F2F6", ink: "#277590" },
  success: { border: "#BFDCCE", fill: "#E8F3EE", ink: "#1C7A52" },
  warning: { border: "#E8D6AC", fill: "#FBF2E0", ink: "#8A6206" },
  danger: { border: "#EFCBC7", fill: "#FBECEA", ink: "#B3352C" },
} as const;

export type EmailStatusTone = keyof typeof TONE;

export type EmailButton = { label: string; path: string };

export type EmailBody = {
  /** Short line under the header, e.g. the reference number. */
  preheader: string;
  heading: string;
  /**
   * The status chip, under the heading — the app's most recognisable component
   * and the reason one of these reads as VizServe rather than as any
   * transactional email.
   *
   * ⚠️ THE LABEL IS HUMAN WORDING, NEVER THE ENUM. "Awaiting review", not
   * `PENDING_REVIEW`. The labels live in `lib/schemas/*` and are not restated
   * at a call site.
   *
   * State is never carried by colour alone: the chip renders its dot AND its
   * label, so it survives greyscale, a screenshot and a printed queue.
   */
  status?: { label: string; tone: EmailStatusTone };
  /** Paragraphs, rendered in order. Escaped for you. */
  paragraphs: string[];
  /** Label/value rows, e.g. "Target date — 5 Aug 2026". Escaped for you. */
  facts?: { label: string; value: string }[];
  /**
   * A quiet line under the detail card. The reference number lives here rather
   * than as a row in the table: it is a "keep this" not a "read this", and a
   * full-width labelled row spends the reader's attention on the one value they
   * do not need in order to act.
   */
  factsNote?: string;
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
  // A one-cell table, not an inline-block span: Word collapses padding on an
  // inline element, which would leave the chip's label touching its border.
  const chip = body.status;
  const status = chip
    ? (() => {
        const tone = TONE[chip.tone];
        return `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
                  <tr>
                    <td style="height:28px;padding:0 10px;background:${tone.fill};border:1px solid ${tone.border};border-radius:8px;color:${tone.ink};font-size:12px;font-weight:600;line-height:28px;white-space:nowrap;">
                      <span style="display:inline-block;width:6px;height:6px;margin-right:7px;background:${tone.ink};border-radius:50%;vertical-align:middle;">&nbsp;</span><span style="vertical-align:middle;">${escapeHtml(chip.label)}</span>
                    </td>
                  </tr>
                </table>`;
      })()
    : "";

  /*
   * The detail block, drawn as the app draws one: a `Card` with a title, and a
   * `<dl>` of `Row`s inside it -- a 9rem label column in `text-xs
   * text-muted-foreground`, the value in `text-sm`, a hairline under every row
   * but the last (`border-b ... last:border-0`).
   *
   * It used to be a bare two-column table with no frame and no heading, which
   * is a database printout rather than a card. Ten unframed rows of
   * label-then-value is exactly what that looks like.
   */
  const factRows = (body.facts ?? [])
    .map(
      (fact, index, all) => `
                      <tr>
                        <td style="padding:10px 14px 10px 16px;${index === all.length - 1 ? "" : `border-bottom:1px solid ${BORDER};`}color:${INK_META};font-size:13px;line-height:1.45;width:144px;vertical-align:top;">${escapeHtml(fact.label)}</td>
                        <td style="padding:10px 16px 10px 0;${index === all.length - 1 ? "" : `border-bottom:1px solid ${BORDER};`}color:${INK};font-size:14px;line-height:1.45;font-weight:500;vertical-align:top;">${escapeHtml(fact.value)}</td>
                      </tr>`,
    )
    .join("");

  const facts = factRows
    ? `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="margin:22px 0 0;background:${CARD};border:1px solid ${BORDER};border-radius:10px;">
                  <tr>
                    <td style="padding:12px 16px;border-bottom:1px solid ${BORDER};color:${INK};font-size:13px;font-weight:700;letter-spacing:-.01em;">Your request</td>
                  </tr>
                  <tr>
                    <td style="padding:0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${factRows}
                      </table>
                    </td>
                  </tr>
                </table>${
                  body.factsNote
                    ? `
                <div style="margin:8px 2px 0;color:${INK_META};font-size:12px;line-height:1.45;">${escapeHtml(body.factsNote)}</div>`
                    : ""
                }`
    : "";

  // FLAT, and that is a rule rather than a preference: a fill and a border, no
  // shadow. Depth in this system is outward only — the panel lifts, the blocks
  // inside it do not.
  const quote = body.quote
    ? `
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;">
                  <tr>
                    <td style="padding:14px 16px;background:${MUTED};border:1px solid ${BORDER};border-left:3px solid ${PRIMARY};border-radius:8px;">
                      <div style="color:${INK_META};font-size:12px;line-height:1.4;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px;">${escapeHtml(body.quote.label)}</div>
                      <div style="color:${INK};font-size:15px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(body.quote.text)}</div>
                    </td>
                  </tr>
                </table>`
    : "";

  /*
   * CENTRED AND BIG. It was left-aligned at the app's 40px control height,
   * which is right for a button among other controls on a page and wrong for
   * the single thing an email exists to get clicked. `align="center"` is an
   * ATTRIBUTE as well as a margin because Word ignores `margin:auto` on a
   * table.
   *
   * The fill is on the CELL and the padding on the anchor: Word drops padding
   * from an inline anchor, which turns the one thing the email exists for into
   * a line of blue text. `background` carries the flat colour for clients that
   * ignore `background-image`, so the gradient is a refinement, never load-
   * bearing.
   */
  const button = body.button
    ? `
                <table class="vz-btn" role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 0;">
                  <tr>
                    <td align="center" style="background:${PRIMARY};background-image:${GRADE_PRIMARY};border-radius:10px;box-shadow:${ELEV_CONTROL};">
                      <a href="${absoluteUrl(body.button.path)}"
                         style="display:inline-block;padding:0 36px;height:52px;color:#ffffff;font-family:${FONT};font-size:17px;font-weight:700;line-height:52px;letter-spacing:-.01em;text-decoration:none;white-space:nowrap;">${escapeHtml(body.button.label)}</a>
                    </td>
                  </tr>
                </table>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!-- Opt out of the client's own dark-mode inversion. Gmail and Outlook
       recolour an unlabelled email by guessing, and a guessed palette puts grey
       text on a grey panel more often than it gets it right. The app has a real
       dark theme; an email cannot use it, so it does not pretend to. -->
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(body.heading)}</title>
  <style>
    /* Stripped by Gmail, ignored by Outlook. Everything below refines a layout
       that is already correct without it — nothing here is load-bearing. */
    @import url("https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap");
    @media only screen and (max-width: 600px) {
      .vz-gutter { padding-left: 16px !important; padding-right: 16px !important; }
      .vz-panel { padding: 24px 20px !important; }
      .vz-btn a { display: block !important; text-align: center !important; }
      /* The header links drop below the lockup rather than crowding it. */
      .vz-nav { display: block !important; width: 100% !important; text-align: left !important; padding-top: 10px !important; }
      .vz-nav a { padding-left: 0 !important; padding-right: 16px !important; }
      /* Two offices side by side need 640px; they stack on a phone. */
      .vz-office { display: block !important; width: 100% !important; text-align: left !important; padding: 10px 0 0 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${GROUND};-webkit-font-smoothing:antialiased;">
  <!-- Preheader: the grey line every inbox shows next to the subject. Left
       empty, clients scrape the first words of the body instead, which here
       would be the word "VizServe" repeated. The blank run after it stops the
       lockup being pulled in behind it. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(body.preheader)}</div>
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">&#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
    <tr>
      <td align="center" class="vz-gutter" style="padding:36px 24px 28px;">

        <!-- The lockup sits ON THE GROUND, above the panel — the same
             arrangement as the client-facing pages, where it is the first thing
             read and the card is a separate object beneath it.
             The wordmark is TEXT beside the mark, never part of the image:
             Outlook and Gmail block remote images by default, and an identity
             that vanishes with the images is what makes a client read an
             approval request as phishing. -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;margin:0 0 18px;font-family:${FONT};">
          <tr>
            <td style="width:52px;vertical-align:middle;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="width:52px;height:52px;background:${PRIMARY};background-image:${GRADE_PRIMARY};border-radius:12px;box-shadow:${ELEV_CONTROL};">
                    <img src="${absoluteUrl(LOGO)}" alt="VizServe" width="32" height="29"
                         style="display:block;width:32px;height:auto;border:0;outline:none;">
                  </td>
                </tr>
              </table>
            </td>
            <td style="padding-left:14px;vertical-align:middle;">
              <div style="color:${INK};font-size:19px;font-weight:700;line-height:1.2;letter-spacing:-.02em;">VizServe</div>
              <div style="color:${INK_META};font-size:13px;line-height:1.35;">Team Portal</div>
            </td>
            <!-- The link row, opposite the mark. It collapses under the lockup
                 on a narrow screen rather than squeezing both onto one line. -->
            <td class="vz-nav" align="right" style="vertical-align:middle;font-size:13px;line-height:1.4;">
              ${CONTACT.headerLinks
                .map(
                  (link) =>
                    `<a href="${link.url}" style="color:${INK_MUTED};text-decoration:none;font-weight:600;">${escapeHtml(link.label)}</a>`,
                )
                .join(`<span style="color:${BORDER};padding:0 10px;">&#124;</span>`)}
            </td>
          </tr>
        </table>

        <!-- The panel. A Card: rounded-lg, a hairline border, the surface grade
             over a white fill, and shadow-raised-lg beneath. White ON grey. -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:640px;background:${CARD};background-image:${GRADE_SURFACE};border:1px solid ${BORDER};border-radius:10px;box-shadow:${ELEV_PANEL};font-family:${FONT};">
          <tr>
            <td class="vz-panel" style="padding:32px;">
              <h1 style="margin:0 0 12px;color:${INK};font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-.015em;">${escapeHtml(body.heading)}</h1>
              ${status}${body.paragraphs
                .map(
                  (p) =>
                    `<p style="margin:0 0 14px;color:${INK_MUTED};font-size:16px;line-height:1.55;letter-spacing:-.005em;">${escapeHtml(p)}</p>`,
                )
                .join("")}
              ${facts}${quote}
              ${button}
              ${body.footnote ? `<p style="margin:16px 0 0;color:${INK_META};font-size:13px;line-height:1.5;${body.button ? "text-align:center;" : ""}">${escapeHtml(body.footnote)}</p>` : ""}
            </td>
          </tr>
        </table>

        <!-- Outside the panel, on the ground. It is about the system, not about
             the message, and the card is the message. -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;font-family:${FONT};">
          <tr>
            <td style="padding:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="margin:18px 0 0;background:${CARD};background-image:${GRADE_SURFACE};border:1px solid ${BORDER};border-radius:12px;">
                <tr>
                  <td class="vz-gutter" style="padding:22px 24px 18px;">
                    <div style="color:${INK};font-size:15px;font-weight:700;letter-spacing:-.015em;">Get in touch</div>
                    <div style="margin-top:4px;color:${INK_META};font-size:12px;line-height:1.5;">${escapeHtml(CONTACT.hours)}</div>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0;">
                      <tr>
                        ${CONTACT.offices
                          .map(
                            (office) => `<td class="vz-office" width="50%" style="width:50%;padding:0 12px 0 0;vertical-align:top;">
                          <div style="color:${INK};font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(office.label)}</div>
                          <div style="margin-top:4px;color:${INK_META};font-size:12px;line-height:1.5;">${escapeHtml(office.lines)}</div>
                        </td>`,
                          )
                          .join("")}
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0;border-top:1px solid ${BORDER};">
                      <tr>
                        <td class="vz-office" style="padding:14px 0 0;vertical-align:middle;">
                          <a href="tel:${CONTACT.phone.replace(/[^+0-9]/g, "")}" style="color:${PRIMARY};font-size:13px;font-weight:600;text-decoration:none;">${escapeHtml(CONTACT.phone)}</a>
                          <span style="color:${BORDER};padding:0 8px;">&#124;</span>
                          <a href="mailto:${CONTACT.email}" style="color:${PRIMARY};font-size:13px;font-weight:600;text-decoration:none;">${escapeHtml(CONTACT.email)}</a>
                        </td>
                        <td class="vz-office" align="right" style="padding:14px 0 0;vertical-align:middle;">
                          ${CONTACT.social
                            .map(
                              (link) =>
                                `<a href="${link.url}" style="color:${INK_MUTED};font-size:13px;font-weight:600;text-decoration:none;">${escapeHtml(link.label)}</a>`,
                            )
                            .join(`<span style="color:${BORDER};padding:0 8px;">&#124;</span>`)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:14px 4px 0;color:${INK_META};font-size:11px;line-height:1.55;">${escapeHtml(CONTACT.copyright)}</td>
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

  // The chip's label, never its tone. This is the greyscale case taken to its
  // limit — there is no colour here at all, so the word has to carry it.
  if (body.status) lines.push(`Status: ${body.status.label}`, "");

  lines.push(...body.paragraphs, "");

  for (const fact of body.facts ?? []) {
    lines.push(`${fact.label}: ${fact.value}`);
  }
  if (body.facts?.length) lines.push("");
  if (body.factsNote) lines.push(body.factsNote, "");

  if (body.quote) {
    lines.push(`${body.quote.label}:`, ...body.quote.text.split("\n").map((l) => `  ${l}`), "");
  }

  if (body.button) {
    lines.push(`${body.button.label}: ${absoluteUrl(body.button.path)}`, "");
  }

  if (body.footnote) lines.push(body.footnote, "");

  lines.push("— VizServe Team Portal");
  lines.push("");

  // The same details as the HTML footer. A plain-text reader gets the phone
  // number too, or the text part becomes the degraded copy rather than the
  // equivalent one.
  lines.push("Get in touch");
  for (const office of CONTACT.offices) lines.push(`${office.label}: ${office.lines}`);
  lines.push(CONTACT.hours, `${CONTACT.phone} · ${CONTACT.email}`);
  for (const link of CONTACT.social) lines.push(`${link.label}: ${link.url}`);
  lines.push("", CONTACT.copyright);

  return lines.join("\n");
}

import { describe, expect, it } from "vitest";

import { emailMode } from "@/lib/email/config";
import { sendEmail } from "@/lib/email/send";

/**
 * P0-11 exit criterion — "a test email sends and lands in an inbox, not spam".
 *
 * That is not something a unit test can assert; a human has to look in an
 * inbox. This does the sending half and tells you where to look.
 *
 *   EMAIL_TEST_RECIPIENT=you@yourdomain.com npm run email:test
 *
 * Opt-in by design. It sends real mail, so it must never run as a side effect of
 * `npm run verify` on someone's laptop.
 *
 * P4-14 repeats this exercise against a real client-domain address early in
 * Phase 4 — deliverability is the one item where a late failure has no
 * workaround, so it is worth re-running rather than trusting this one.
 */

const recipient = process.env.EMAIL_TEST_RECIPIENT;

if (!recipient) {
  console.warn(
    "\n  deliverability.test.ts — SKIPPED. Set EMAIL_TEST_RECIPIENT (and RESEND_API_KEY)" +
      " to send a real message.\n",
  );
}

describe.skipIf(!recipient)("P0-11 deliverability", () => {
  it("sends the real template to a real address", async () => {
    const outcome = await sendEmail({
      to: recipient!,
      subject: "VizServe PMS — deliverability check (P0-11)",
      body: {
        preheader: "Confirming transactional email is wired end to end.",
        heading: "Transactional email is working",
        paragraphs: [
          "If you are reading this in an inbox rather than a spam folder, P0-11 is done.",
          "This message went through the same template, the same sender and the same safety gate as every notification the system sends.",
        ],
        facts: [
          { label: "Mode", value: emailMode() },
          { label: "Backlog item", value: "P0-11" },
        ],
        button: { label: "Open VizServe PMS", path: "/" },
        footnote:
          "Check the sender reputation and the spam score before Phase 4 — one client email is what that whole phase rests on.",
      },
    });

    if (outcome.status === "dry-run") {
      throw new Error(
        "RESEND_API_KEY is not set, so nothing was sent. This test only proves " +
          "anything in live mode.",
      );
    }

    expect(outcome.status).toBe("sent");
    console.info(
      `\n  ✓ Sent to ${recipient}. Now go and look: it must be in the INBOX, not spam.\n`,
    );
  });

  it("refuses to send to a reserved domain even when asked directly", async () => {
    // The gate is not advisory. Worth asserting in the same run that proves
    // sending works, so nobody concludes "email is on" and forgets it is fenced.
    const outcome = await sendEmail({
      to: "test.admin@example.com",
      subject: "Should never arrive",
      body: { preheader: "x", heading: "x", paragraphs: ["x"] },
    });

    expect(outcome.status).toBe("skipped");
  });
});

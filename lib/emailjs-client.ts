"use client";

import emailjs from "@emailjs/browser";

import type { EmailJsConfig, EmailJsParams } from "@/lib/emailjs";

/**
 * P7-49 — the one place `emailjs.send` is called.
 *
 * Separate from `lib/emailjs.ts` so the SDK is only ever pulled into a client
 * bundle. That file is imported by server components (it reads `process.env`),
 * and importing a browser SDK there would either break the build or ship it to
 * the server for no reason.
 *
 * ⚠️ NEVER THROWS, and never rejects. Every caller is in a path where the real
 * work has already succeeded — the request is committed, the approval is
 * committed, the task exists. An email that fails must not surface as a failed
 * submission, because the client's next move is to submit again and now
 * somebody has a duplicate to find and close.
 *
 * The outcome is returned so a caller can log it, and the console line is
 * deliberately noisy: this is the only trace a browser-side send leaves.
 */
export type EmailJsOutcome =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export async function sendClientEmail(
  config: EmailJsConfig | null,
  params: EmailJsParams,
): Promise<EmailJsOutcome> {
  // Not configured is a normal state, not a fault — `emailJsConfig()` returns
  // null when the keys are absent, so a developer without them still gets a
  // working form.
  if (!config) {
    return { status: "skipped", reason: "EmailJS is not configured" };
  }

  // Narrowed, not asserted. The params bag now also carries the timeline array
  // for the template's loop, so `to_email` is `string | EmailTimelineEntry[]`
  // to the type system even though only a builder in `lib/emailjs.ts` fills it.
  // A wrong-typed recipient falls through to the skip below rather than
  // reaching EmailJS as `[object Object]`.
  const recipient = typeof params.to_email === "string" ? params.to_email.trim() : undefined;

  if (!recipient || !recipient.includes("@")) {
    return { status: "skipped", reason: `not an email address: ${recipient ?? "(none)"}` };
  }

  /*
   * The same reserved-domain rule the server mailer enforces.
   *
   * Every seeded account is @example.com and dev must never deliver real mail
   * (docs/04). The server path has `isDeliverable` for this; a browser send
   * bypasses that entirely, so the rule is restated here rather than assumed.
   * Without it, testing the public form with a seeded address would put real
   * mail through EmailJS's quota to an address that cannot receive it.
   */
  const domain = recipient.toLowerCase().split("@")[1] ?? "";
  const reserved = ["example.com", "example.org", "example.net", "test", "invalid", "localhost"];

  if (reserved.some((value) => domain === value || domain.endsWith(`.${value}`))) {
    return { status: "skipped", reason: `reserved domain, never delivered: ${recipient}` };
  }

  try {
    await emailjs.send(config.serviceId, config.templateId, params, {
      publicKey: config.publicKey,
    });

    console.info(`[emailjs] → ${recipient} — ${params.reference_no} ${params.status_label}`);
    return { status: "sent" };
  } catch (error) {
    // EmailJS rejects with an object carrying `text`, not an Error.
    const message =
      typeof error === "object" && error !== null && "text" in error
        ? String((error as { text: unknown }).text)
        : String(error);

    console.error(`[emailjs] FAILED → ${recipient} — ${message}`);
    return { status: "failed", error: message };
  }
}

"use server";

import { headers } from "next/headers";

import { issueAndSendFeedbackRequest } from "@/lib/client-approval-server";
import {
  clientDecisionSchema,
  feedbackSchema,
  type ClientDecisionInput,
} from "@/lib/schemas/client-approval";
import { createClient } from "@/utils/supabase/server";

/**
 * P4-05 — the decision handler, app side.
 *
 * A courier again. Every rule that matters is in
 * `vizserve_pms_record_client_decision`: the hash comparison, the expiry, the
 * consumed check, the task-status check, the mandatory comment. That function is
 * the copy a `curl` cannot skip, and duplicating any of it here would create a
 * second place for it to drift.
 *
 * What DOES belong here is the IP and user agent — they exist in the HTTP
 * request and nowhere else, and they are the evidence if a client later disputes
 * an approval.
 */

export type DecisionResult =
  { ok: true; decision: string; status: string } | { ok: false; error: string };

/** Every failure said the same way, so a probe learns nothing from the wording. */
const MESSAGES: Record<string, string> = {
  invalid: "This link is not valid. Check you used the most recent email we sent you.",
  expired: "This link has expired. Get in touch and we will send a new one.",
  already_used: "This request has already been answered. Thank you.",
  no_longer_open: "This request is no longer waiting for your approval.",
  comment_required: "Please tell us what needs changing.",
  invalid_rating: "Choose a rating from 1 to 5.",
};

function clientIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headerList.get("x-real-ip");
}

export async function submitClientDecision(token: string, input: unknown): Promise<DecisionResult> {
  const parsed = clientDecisionSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check what you entered and try again.",
    };
  }

  const payload: ClientDecisionInput = parsed.data;
  const headerList = await headers();

  // The ordinary anon client, exactly like the public form. `anon` holds no
  // table privilege at all — this RPC is the only way in.
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("vizserve_pms_record_client_decision", {
    p_token: token,
    p_decision: payload.decision,
    p_comment: "comment" in payload ? (payload.comment ?? null) : null,
    p_approver_name: payload.approver_name ?? null,
    p_ip: clientIp(headerList),
    p_user_agent: headerList.get("user-agent")?.slice(0, 400) ?? null,
  });

  if (error) {
    console.error(`[gate3] decision failed: ${error.message}`);
    return { ok: false, error: "Something went wrong. Please try again." };
  }

  const result = data as { ok: boolean; error?: string; decision?: string; status?: string };

  if (!result.ok) {
    return { ok: false, error: MESSAGES[result.error ?? ""] ?? MESSAGES.invalid! };
  }

  // P4-10 — feedback goes out on every completion, including this one. Not
  // awaited: the client is looking at a confirmation screen and should not wait
  // on our mail server to see it.
  if (result.decision === "APPROVED") {
    void issueAndSendFeedbackRequest((data as { task_id?: string }).task_id ?? "", {
      autoCompleted: false,
    }).catch(() => {
      // Best effort. A missing feedback email is not worth failing an approval.
    });
  }

  return { ok: true, decision: result.decision!, status: result.status! };
}

export async function submitFeedback(
  token: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = feedbackSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: "Choose a rating from 1 to 5." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vizserve_pms_submit_feedback", {
    p_token: token,
    p_rating: parsed.data.rating,
    p_comment: parsed.data.comment ?? null,
  });

  if (error) return { ok: false, error: "Something went wrong. Please try again." };

  const result = data as { ok: boolean; error?: string };
  if (!result.ok) return { ok: false, error: MESSAGES[result.error ?? ""] ?? MESSAGES.invalid! };

  return { ok: true };
}

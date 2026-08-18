import type { Metadata } from "next";

import { approvalPageResultSchema } from "@/lib/schemas/client-approval";
import { createClient } from "@/utils/supabase/server";

import { FeedbackForm } from "./feedback-form";
import { BrandLockup } from "@/components/brand-lockup";

export const metadata: Metadata = {
  title: "How did we do?",
  robots: { index: false, follow: false },
};

/**
 * P4-10 — the feedback page.
 *
 * Same token machinery as the approval page, separate token. Separate because a
 * single token doing both would mean feedback shares an expiry and a
 * `consumed_at` with the approval — so approving would consume the ability to
 * comment afterwards, which is precisely backwards.
 *
 * One rating and one optional comment. Amier at 54:30 wanted feedback per
 * request rather than periodic, and per-request feedback only gets answered if
 * it costs a few seconds.
 */
export default async function FeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();

  const { data } = await supabase.rpc("vizserve_pms_get_approval_page", { p_token: token });
  const parsed = data ? approvalPageResultSchema.safeParse(data) : null;
  const page = parsed?.success && parsed.data.ok ? parsed.data : null;

  return (
    <main className="client-surface min-h-svh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-5">
          <BrandLockup align="stacked" subtitle="Feedback" />
        </div>

        {!page ? (
          <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-8 text-center">
            <h1 className="text-lg font-semibold">This link is not valid</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Check that you used the most recent email we sent you.
            </p>
          </div>
        ) : page.consumed ? (
          <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-8 text-center">
            <h1 className="text-lg font-semibold">Thank you</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              We already have your feedback on this one.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border bg-card grade-surface shadow-raised-lg p-6 sm:p-8">
            <p className="text-xs text-muted-foreground">{page.reference_no}</p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight">How did we do?</h1>
            <p className="mt-1 text-sm text-muted-foreground">{page.title}</p>

            <div className="mt-6">
              <FeedbackForm token={token} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

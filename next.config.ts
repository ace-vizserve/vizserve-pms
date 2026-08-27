import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Attachments are uploaded through a Server Action, and Next caps a Server
     * Action body at 1 MB by default. `vizserve_pms_attachment_rules.max_bytes`
     * has said 10 MiB since P1-09, so every file between those two numbers
     * failed with a framework stack trace pointing at `<FileField>` — not at the
     * rule it was actually breaking, and not with the app's own message.
     *
     * Matched to the DATABASE rule rather than picked. That rule is the one the
     * upload path enforces on the real bytes (`uploadPendingAttachment`), and it
     * is admin-editable — so this is the ceiling under which the app's own
     * validation gets to speak. A smaller number here would mean the framework
     * rejecting a file the app considers legal, which is exactly the failure
     * being fixed.
     *
     * ⚠️ IF `max_bytes` IS RAISED, RAISE THIS TOO. They are two copies of one
     * number and nothing enforces that they agree.
     *
     * PER FILE, NOT PER FORM. `<FileField>` uploads sequentially — one action
     * call per file, deliberately, so a client on office wifi does not start
     * five simultaneous uploads and collect five timeouts. So this bounds the
     * largest single file, not the total attached.
     *
     * ⚠️ THIS IS NOT ENOUGH FOR PRODUCTION ON VERCEL. Serverless functions there
     * reject a request body over ~4.5 MB before any of this is consulted, and no
     * Next config raises it. On `vizserve-pms.vercel.app` (D17) a 6 MB file will
     * still fail, and the error will be worse than this one because it happens
     * at the platform edge. Two ways out, and they are not equivalent:
     *
     *   - Lower `max_bytes` to ~4 MiB. One SQL update, honest everywhere, and
     *     the app's own error message is what the client sees.
     *   - Upload straight to Supabase Storage with a signed URL, bypassing the
     *     function entirely. Supports the full 10 MiB — but it also bypasses
     *     `uploadPendingAttachment`, which is where the MIME allowlist and the
     *     magic-number check run against the real bytes. That check exists
     *     because "this is the last point at which the real bytes exist"; moving
     *     the upload off the server means re-implementing it after the fact or
     *     losing it. Not a change to make casually.
     */
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;

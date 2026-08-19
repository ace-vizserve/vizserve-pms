import { permanentRedirect } from "next/navigation";

/**
 * P7-29 — the old public form address, kept for good.
 *
 * The form moved from `/f/[slug]` to `/request/[slug]`, because `/f/` says
 * nothing to the person it was written for. A client who has the old link has
 * it in an email, a bookmark, a chat message or a printed brief, and none of
 * those can be recalled — so this is not a transitional shim with a date on it.
 * It stays.
 *
 * 308 rather than 307: permanent, and the method is preserved. A GET is all
 * that ever arrives here anyway — the submission POSTs to a server action bound
 * to the new page, so nothing that writes passes through this file.
 *
 * ⚠️ `/f/` MUST STAY IN THE PROXY'S PUBLIC ALLOWLIST. Removing it would put a
 * login page in front of the redirect itself, so an old link would ask a client
 * with no account to sign in rather than forwarding them — a worse failure than
 * the 404 the redirect exists to prevent.
 */
export default async function LegacyFormRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // `encodeURIComponent`, because the slug arrives from the URL and is echoed
  // straight back into one. A form's own slug can only be [a-z0-9-], but this
  // route accepts whatever was typed, valid or not.
  permanentRedirect(`/request/${encodeURIComponent(slug)}`);
}

import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";

import { requireAuthContext } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { formatDateTime } from "@/lib/dates";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Inbox" };

/**
 * P0-10 — the inbox.
 *
 * "One place to look" (docs/12 §3): every emailed event also writes a row here,
 * so email is a nudge toward the inbox rather than a separate truth. Anything
 * that does NOT email still lands here — that is the whole point of the split.
 *
 * RLS restricts rows to `user_id = auth.uid()`, so this query carries no filter
 * and cannot leak someone else's notifications by omission.
 *
 * Unread counts on the nav badge are deliberately deferred (Amier, 21:20).
 */
export default async function InboxPage() {
  await requireAuthContext();
  const supabase = await createClient();

  const { data: notifications } = await supabase
    .from("vizserve_pms_notifications")
    .select("id, type, title, body, link_path, read_at, created_at, send_email, emailed_at")
    .order("created_at", { ascending: false })
    .limit(100);

  const unreadCount = (notifications ?? []).filter((n) => !n.read_at).length;

  async function markAllRead() {
    "use server";
    await requireAuthContext();
    const client = await createClient();
    // No `.eq("user_id", …)`: RLS already scopes the update to the caller's own
    // rows, and restating it here would imply the policy is optional.
    await client
      .from("vizserve_pms_notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    revalidatePath("/inbox");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Requests awaiting you, and changes on work you are part of.
          </p>
        </div>
        {unreadCount > 0 ? (
          <form action={markAllRead}>
            <Button type="submit" variant="outline" size="sm">
              Mark all read
            </Button>
          </form>
        ) : null}
      </div>

      {!notifications || notifications.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">Nothing yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            You will be notified here when a request needs your approval, or when work you are
            assigned to moves.
          </p>
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {notifications.map((item) => {
            const content = (
              <div className="flex items-start gap-3 p-4">
                <span
                  aria-hidden
                  className={
                    item.read_at
                      ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-transparent"
                      : "mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className={item.read_at ? "text-sm" : "text-sm font-medium"}>
                    {item.title}
                    {/* Unread is stated, not just dotted — a colour dot alone is
                        not an accessible status. */}
                    {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
                  </p>
                  {item.body ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                  ) : null}
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {formatDateTime(item.created_at)}
                    {item.emailed_at ? " · emailed" : null}
                  </p>
                </div>
              </div>
            );

            return (
              <li key={item.id} className={item.read_at ? "" : "bg-muted/30"}>
                {/* Every notification links to the exact record, never to a
                    dashboard the recipient then has to search (docs/12 §3). */}
                {item.link_path ? (
                  <Link href={item.link_path} className="block hover:bg-muted/50">
                    {content}
                  </Link>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

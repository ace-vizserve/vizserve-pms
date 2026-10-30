import { canTakeDownAnnouncement, type AuthContext } from "@/lib/auth/authorization";
import { formatDate, relativeDays, toAppDateString } from "@/lib/dates";
import type { Announcement } from "@/lib/schemas/announcements";
import type { createClient } from "@/utils/supabase/server";

import { TakeDownAnnouncementButton } from "./announcement-controls";

/**
 * P17-04 — the live announcements, shared by `/` and `/dashboard` so the two
 * cannot disagree about what is up. Live = not taken down and not past its
 * last day.
 *
 * `null` when the read failed — the table is not there until the migration is
 * pasted by hand — so each page can draw nothing rather than an error.
 */
export async function loadAnnouncements(
  supabase: Awaited<ReturnType<typeof createClient>>,
  today: string,
): Promise<Announcement[] | null> {
  const { data, error } = await supabase
    .from("vizserve_pms_announcements")
    .select("id, title, body, expires_on, created_by, author_name, created_at")
    .is("archived_at", null)
    .or(`expires_on.is.null,expires_on.gte.${today}`)
    .order("created_at", { ascending: false })
    .limit(5);

  return error ? null : ((data ?? []) as Announcement[]);
}

/** The rows. Each page supplies its own frame and empty state. */
export function AnnouncementItems({
  announcements,
  context,
}: {
  announcements: Announcement[];
  context: AuthContext;
}) {
  return announcements.map((item) => (
    <article key={item.id} className="flex gap-2.5 border-b px-4 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{item.title}</h3>
        {/* All of it, one column, nothing hidden. A blank line between
            paragraphs becomes a small gap rather than a whole empty line. */}
        <div className="mt-0.5 text-xs text-foreground-muted">
          {item.body
            .split(/\n\s*\n/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean)
            .map((paragraph, index) => (
              <p key={index} className="mb-1.5 whitespace-pre-line last:mb-0">
                {paragraph}
              </p>
            ))}
        </div>
        <p className="mt-1 text-2xs text-muted-foreground">
          {item.author_name || "Someone"} · {relativeDays(toAppDateString(new Date(item.created_at)))}
          {item.expires_on ? ` · until ${formatDate(item.expires_on)}` : null}
        </p>
      </div>
      {canTakeDownAnnouncement(context, item) ? (
        <div className="shrink-0">
          <TakeDownAnnouncementButton id={item.id} title={item.title} />
        </div>
      ) : null}
    </article>
  ));
}

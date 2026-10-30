import { canTakeDownAnnouncement, type AuthContext } from "@/lib/auth/authorization";
import { formatDate, relativeDays, toAppDateString } from "@/lib/dates";
import type { Announcement, AnnouncementReactionRow } from "@/lib/schemas/announcements";
import type { createClient } from "@/utils/supabase/server";

import { TakeDownAnnouncementButton } from "./announcement-controls";
import { AnnouncementReactions } from "./announcement-reactions";

/**
 * An announcement with its reactions (P17-06). `reactions` is null when that
 * read failed — the table is not there until its migration is pasted — and the
 * row then draws no reaction bar rather than an error.
 */
export type AnnouncementWithReactions = Announcement & {
  reactions: AnnouncementReactionRow[] | null;
};

/**
 * P17-04 — the live announcements, shared by `/` and `/dashboard` so the two
 * cannot disagree about what is up. Live = not taken down and not past its
 * last day.
 *
 * `null` when the read failed — the table is not there until the migration is
 * pasted by hand — so each page can draw nothing rather than an error.
 *
 * P17-06 — the reactions come in a second read keyed on the (at most five)
 * ids, so a missing reactions table costs the bar and nothing else.
 */
export async function loadAnnouncements(
  supabase: Awaited<ReturnType<typeof createClient>>,
  today: string,
): Promise<AnnouncementWithReactions[] | null> {
  const { data, error } = await supabase
    .from("vizserve_pms_announcements")
    .select("id, title, body, expires_on, created_by, author_name, created_at")
    .is("archived_at", null)
    .or(`expires_on.is.null,expires_on.gte.${today}`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) return null;
  const announcements = (data ?? []) as Announcement[];
  if (announcements.length === 0) return [];

  const reactions = await supabase
    .from("vizserve_pms_announcement_reactions")
    .select("announcement_id, user_id, user_name, reaction, created_at")
    .in(
      "announcement_id",
      announcements.map((item) => item.id),
    );

  const rows = reactions.error ? null : ((reactions.data ?? []) as AnnouncementReactionRow[]);

  return announcements.map((item) => ({
    ...item,
    reactions: rows ? rows.filter((row) => row.announcement_id === item.id) : null,
  }));
}

/** The rows. Each page supplies its own frame and empty state. */
export function AnnouncementItems({
  announcements,
  context,
}: {
  announcements: AnnouncementWithReactions[];
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
        {/* P17-06. "Seen" without a reply; hover a pill for who. */}
        {item.reactions ? (
          <AnnouncementReactions
            announcementId={item.id}
            title={item.title}
            viewerId={context.userId}
            initial={item.reactions}
          />
        ) : null}
      </div>
      {canTakeDownAnnouncement(context, item) ? (
        <div className="shrink-0">
          <TakeDownAnnouncementButton id={item.id} title={item.title} />
        </div>
      ) : null}
    </article>
  ));
}

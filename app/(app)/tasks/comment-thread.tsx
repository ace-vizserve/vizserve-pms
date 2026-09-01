"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

import { addTaskComment, deleteTaskComment, editTaskComment } from "./actions";
import { Monogram, initials } from "./assignees";

export type TaskComment = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * P7-57 — SOMETHING THAT HAPPENED AND CARRIED WORDS, next to the comments.
 *
 * A QA reviewer sending work back and a client asking for changes are the two
 * things a PIC most needs to see, and neither was a comment: both are rows in
 * `vizserve_pms_task_status_history` with their note in `comment`. They rendered
 * only in the History trail, one line among a dozen moves, indistinguishable
 * from "Open → Ongoing".
 *
 * ⚠️ ONLY MOVES THAT CARRIED WORDS COME HERE. A plain move — nobody said
 * anything, the status changed — stays in History alone. Drawing every move in
 * both places is one fact drawn twice, which is not emphasis; it is noise that
 * makes the reader check whether they are two different things.
 *
 * ⚠️ AND THE CLIENT'S REPLY COMES FROM HISTORY, NOT FROM `client_decisions`.
 * `vizserve_pms_decide_task` writes BOTH in one statement — a history row with
 * the client's comment, and a decisions row with the same comment plus the
 * approver's name. Reading both would print the client's words twice. The
 * decisions table supplies the NAME and nothing else (`page.tsx`).
 */
export type TaskActivityEvent = {
  id: string;
  /**
   * `qa` the reviewer sent it back · `client` Gate 3 answered · `note` any other
   * move that carried words, which in practice is parking it for information.
   */
  kind: "qa" | "client" | "note";
  who: string;
  /** For the monogram's tint. Null for the client, who has no user row. */
  whoId: string | null;
  at: string;
  /** The move it rode in on. Null on the row that created the task. */
  from: string | null;
  to: string;
  /** What they actually said. */
  said: string | null;
  /**
   * The newest return still waiting on somebody. Exactly one entry carries it,
   * and only while the task is back with the PIC — see `page.tsx`.
   */
  live?: boolean;
};

/** The QA / Client label on an entry. Muted grey would lose the distinction. */
const TAG = {
  qa: "border-warning-border bg-warning-subtle text-warning",
  client: "border-info-border bg-info-subtle text-info",
  note: "",
} as const;

/** The tinted box on the one entry that is still somebody's move. */
const LIVE = {
  qa: "border-warning-border bg-warning-subtle",
  client: "border-info-border bg-info-subtle",
  note: "border-border bg-muted",
} as const;

const NEEDS = {
  qa: "Sent back to you — needs changes",
  client: "The client asked for changes",
  note: "Waiting on somebody",
} as const;

/**
 * P7-08 — the conversation on a task, and (P7-57) everything else that was said
 * on it.
 *
 * ONE COMPONENT, TWO PLACES: the popover opened from the "latest comment" cell
 * on the list and the board, and inline on the task detail. Two implementations
 * of the same list is how the two end up disagreeing about whether an edited
 * comment says so. The popover passes no `events` and keeps the shape it had.
 *
 * FLAT AND IN TIME ORDER. Threaded replies, reactions and `@` mentions are all
 * in the reference this came from and none is built: replies need a
 * `parent_comment_id` and a depth rule, reactions need their own table, and
 * mentions need a notification path and a scope question about who may be
 * mentioned. Each is a slice; none is a detail of this one.
 *
 * Author-only edit and delete are enforced in the DATABASE — the UPDATE and
 * DELETE policies test `author_id = auth.uid()`. The controls below are hidden
 * for other people's comments because offering a button the server refuses is
 * worse than not offering it, not because hiding them is the rule.
 */
export function CommentThread({
  taskId,
  comments,
  viewerId,
  className,
  scrollList = false,
  events = [],
  newestFirst = false,
  composerFirst = false,
}: {
  taskId: string;
  comments: TaskComment[];
  viewerId: string;
  className?: string;
  /**
   * P7-55. Cap the LOG and leave the composer pinned below it — the shape a
   * thread panel has, and the reason the rail on `/tasks/[id]` does not grow
   * without bound when a task has forty comments.
   *
   * ⚠️ THE CAP GOES ON THE `<ul>`, NEVER ON THE WRAPPER. The popover in
   * `latest-comment-cell.tsx` used to clamp the whole component, which put the
   * box you type into inside the scroll region — so replying to a long thread
   * meant scrolling down to find the composer. Passing this prop there instead
   * fixed that; one behaviour, two call sites.
   */
  scrollList?: boolean;
  /** QA returns, client replies, parked notes. See `TaskActivityEvent`. */
  events?: TaskActivityEvent[];
  /**
   * Newest at the top. The detail page reads this way because what just happened
   * is what somebody opened the page to find; the popover keeps reading order,
   * because there it is a short conversation rather than a feed.
   */
  newestFirst?: boolean;
  /** The composer above the feed — it belongs at the end you are reading from. */
  composerFirst?: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

  function post() {
    const text = body.trim();
    if (!text) return;

    startTransition(async () => {
      const result = await addTaskComment(taskId, { body: text });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      // Cleared only on success. A comment the server refused stays in the box
      // rather than being lost to a toast nobody can copy out of.
      setBody("");
      router.refresh();
    });
  }

  function saveEdit(commentId: string) {
    const text = draft.trim();
    if (!text) return;

    startTransition(async () => {
      const result = await editTaskComment(commentId, { body: text });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setEditing(null);
      setDraft("");
      router.refresh();
    });
  }

  function remove(commentId: string) {
    startTransition(async () => {
      const result = await deleteTaskComment(commentId);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      router.refresh();
    });
  }

  /*
   * ONE LIST, SORTED ONCE. Merging in the page and passing a single array was
   * the alternative, and it would have meant `page.tsx` — a server component —
   * carrying the comment shape, the event shape and the sort, so that this
   * component could render two things it already knows how to render.
   */
  const feed = [
    ...comments.map((comment) => ({
      at: comment.createdAt,
      comment,
      event: null,
    })),
    ...events.map((event) => ({ at: event.at, comment: null, event })),
  ].sort((a, b) => (newestFirst ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)));

  const composer = (
    <div className="space-y-1.5">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={2}
        placeholder="Write a comment…"
        aria-label="New comment"
        className="text-sm"
        // Enter posts, Shift+Enter breaks the line. The opposite would make
        // every multi-line comment a fight, and these are notes rather than
        // chat messages.
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            post();
          }
        }}
      />
      <div className="flex justify-end">
        <Button size="sm" loading={pending} disabled={!body.trim()} onClick={post}>
          <Send />
          Comment
        </Button>
      </div>
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {composerFirst ? composer : null}

      {feed.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {events.length === 0 && comments.length === 0
            ? "Nothing said yet. This is where the conversation about this task lives, along with anything QA or the client sends back."
            : "No comments yet. This is where the conversation about this task lives."}
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-2.5", scrollList && "max-h-96 overflow-y-auto pr-1")}>
          {feed.map((row) =>
            row.event ? (
              <ActivityEntry key={`event-${row.event.id}`} event={row.event} />
            ) : (
              <li key={row.comment!.id} className="rounded-sm border bg-card px-3 py-2">
                {/*
                  P7-55 — the monogram is what makes a list of boxes read as a
                  thread. It sits ON the existing baseline row, so it costs no
                  vertical height at all.

                  NOT an avatar. `assignees.tsx` rules out inventing a
                  placeholder FACE for a colleague; two letters tinted from the
                  author's id is the house answer, and it is already used on
                  every task row. `components/ui/avatar.tsx` stays unimported.
                */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Monogram name={row.comment!.authorName} id={row.comment!.authorId} />
                  <span className="text-xs font-medium">{row.comment!.authorName}</span>
                  <span className="text-2xs text-muted-foreground">
                    {formatDateTime(row.comment!.createdAt)}
                    {/* Only when it actually changed. A near-identical timestamp
                        on every comment would make the one that WAS edited
                        invisible. */}
                    {row.comment!.updatedAt !== row.comment!.createdAt ? " · edited" : null}
                  </span>
                </div>

                {editing === row.comment!.id ? (
                  <div className="mt-1.5 space-y-1.5">
                    <Textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      autoFocus
                      aria-label="Edit comment"
                      className="text-sm"
                    />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        loading={pending}
                        disabled={!draft.trim()}
                        onClick={() => saveEdit(row.comment!.id)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* `whitespace-pre-wrap`: people write lists in these and a
                        collapsed one reads as a run-on sentence. */}
                    <p className="mt-1 text-sm whitespace-pre-wrap">{row.comment!.body}</p>

                    {row.comment!.authorId === viewerId ? (
                      <div className="mt-1.5 flex gap-2">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            setEditing(row.comment!.id);
                            setDraft(row.comment!.body);
                          }}
                          className="text-2xs text-muted-foreground hover:text-foreground hover:underline">
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => remove(row.comment!.id)}
                          className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-destructive hover:underline">
                          <Trash2 className="size-3" aria-hidden />
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {composerFirst ? null : composer}
    </div>
  );
}

/**
 * One thing that happened and carried words.
 *
 * ⚠️ THE EMPHASIS IS ON THE NEWEST RETURN ONLY, and it is a `live` flag decided
 * by the page rather than by "is this a QA return". A task can carry three QA
 * returns and two client revisions over its life and every one stays in the
 * feed — but only the most recent is still somebody's move. Marking them all
 * would make the live one invisible among its own history.
 *
 * NEVER COLOUR ALONE (§5.5): the tint carries a named line — "Sent back to you
 * — needs changes" — and an alert icon, so it survives greyscale and a printed
 * page.
 */
function ActivityEntry({ event }: { event: TaskActivityEvent }) {
  return (
    <li
      className={cn("rounded-sm border px-3 py-2", event.live ? LIVE[event.kind] : "bg-muted/40")}>
      {event.live ? (
        <p
          className={cn(
            "mb-1 flex items-center gap-1.5 text-2xs font-semibold tracking-wide uppercase",
            event.kind === "client" ? "text-info" : "text-warning",
          )}>
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {NEEDS[event.kind]}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The client has no user row and never will — `decide_task` records
            their decision with a NULL actor deliberately, because attributing it
            to whoever happened to be signed in would be a lie in the one record
            a dispute turns on. So they get a mark, not a tinted monogram. */}
        {event.whoId ? (
          <Monogram name={event.who} id={event.whoId} />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold grade-chip shadow-raised",
              TAG[event.kind] || "border-border bg-muted text-foreground-muted",
            )}>
            {initials(event.who)}
          </span>
        )}

        <span className="text-xs font-medium">{event.who}</span>

        {event.kind === "note" ? null : (
          <span
            className={cn(
              "rounded-sm border px-1.5 py-px text-2xs font-semibold tracking-wide uppercase",
              TAG[event.kind],
            )}>
            {event.kind === "qa" ? "QA" : "Client"}
          </span>
        )}

        <span className="text-2xs text-muted-foreground">{formatDateTime(event.at)}</span>
      </div>

      {event.said ? <p className="mt-1 text-sm whitespace-pre-wrap">{event.said}</p> : null}

      {/* An icon, never a typed arrow. A glyph in a text run inherits the font's
          metrics and sits off the baseline; `ArrowRight` is sized and aligned
          with the words either side, and `aria-hidden` because "Waiting for QA
          Ongoing" already reads as a move to anyone listening rather than
          looking. Same treatment as the History trail, deliberately. */}
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
        {event.from ? (
          <>
            {event.from}
            <ArrowRight className="size-3 shrink-0 text-foreground-faint" aria-hidden />
            {event.to}
          </>
        ) : (
          `Created as ${event.to}`
        )}
      </p>
    </li>
  );
}

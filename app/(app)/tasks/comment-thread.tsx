"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";

import { addTaskComment, deleteTaskComment, editTaskComment } from "./actions";

export type TaskComment = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * P7-08 — the conversation on a task.
 *
 * ONE COMPONENT, TWO PLACES: the popover opened from the "latest comment" cell
 * on the list and the board, and inline on the task detail. Two implementations
 * of the same list is how the two end up disagreeing about whether an edited
 * comment says so.
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
}: {
  taskId: string;
  comments: TaskComment[];
  viewerId: string;
  className?: string;
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

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No comments yet. This is where the conversation about this task lives.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {comments.map((comment) => {
            const mine = comment.authorId === viewerId;
            // Only when it actually changed. A near-identical timestamp on
            // every comment would make the one that WAS edited invisible.
            const edited = comment.updatedAt !== comment.createdAt;

            return (
              <li key={comment.id} className="rounded-sm border bg-card px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-medium">{comment.authorName}</span>
                  <span className="text-2xs text-muted-foreground">
                    {formatDateTime(comment.createdAt)}
                    {edited ? " · edited" : null}
                  </span>
                </div>

                {editing === comment.id ? (
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
                        onClick={() => saveEdit(comment.id)}
                      >
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
                    <p className="mt-1 text-sm whitespace-pre-wrap">{comment.body}</p>

                    {mine ? (
                      <div className="mt-1.5 flex gap-2">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            setEditing(comment.id);
                            setDraft(comment.body);
                          }}
                          className="text-2xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => remove(comment.id)}
                          className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-destructive hover:underline"
                        >
                          <Trash2 className="size-3" aria-hidden />
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

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
    </div>
  );
}

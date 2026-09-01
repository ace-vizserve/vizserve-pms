"use client";

import { MessageSquare } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { CommentThread, type TaskComment } from "./comment-thread";
import { richTextToPlainText } from "@/lib/rich-text";

/**
 * P7-08 / K5 — the latest comment, and the way into the thread.
 *
 * THE CELL IS THE ENTRY POINT, not a preview. Clicking it opens the whole
 * conversation with a composer, in place. A column that can only be READ is a
 * column that goes stale, because replying to it would cost a page load — so
 * the one thing this must not be is a truncated string that links to the task.
 *
 * The thread itself is `CommentThread`, the same component the task detail
 * renders inline. Two implementations of one list is how the two end up
 * disagreeing about whether an edited comment says so.
 */
export function LatestCommentCell({
  taskId,
  taskTitle,
  comments,
  viewerId,
}: {
  taskId: string;
  taskTitle: string;
  /** The whole thread, oldest first. Empty is a real and common state. */
  comments: TaskComment[];
  viewerId: string;
}) {
  const [open, setOpen] = useState(false);
  const latest = comments[comments.length - 1];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "w-full max-w-56 rounded-sm px-1.5 py-1 text-left text-xs",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          latest ? "text-foreground" : "text-muted-foreground",
        )}>
        {latest ? (
          <>
            {/* Two lines, then it stops. The cell is a pointer into the thread,
                not the thread — a row that grows to fit a paragraph pushes
                every other row down the page. */}
            {/* ⚠️ FLATTENED, NOT RENDERED. `line-clamp` counts lines in a
                block box; a <ul> inside this cell would lay out at full height
                and blow the row open. `richTextToPlainText` is the same
                flattener the emails use — bullets survive as "• ". */}
            <span className="line-clamp-2">{richTextToPlainText(latest.body)}</span>
            {comments.length > 1 ? (
              <span className="mt-0.5 block text-2xs text-muted-foreground">{comments.length} comments</span>
            ) : null}
            <span className="sr-only">
              Latest comment on {taskTitle}. Open the thread to read all{" "}
              {comments.length === 1 ? "1 comment" : `${comments.length} comments`} or add one.
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <MessageSquare className="size-3.5" aria-hidden />
            {/* Named as an action rather than left blank. An empty cell reads as
                "this column is broken"; this one says what it is for. */}
            Comment
            <span className="sr-only">on {taskTitle}</span>
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle className="truncate text-sm">{taskTitle}</PopoverTitle>
        </PopoverHeader>

        {/* Capped and scrollable: a task with forty comments must not produce a
            popover taller than the window.

            P7-55 moved the cap from a wrapper onto the thread's own list. The
            wrapper version put the COMPOSER inside the scroll region, so
            replying to a long thread meant scrolling back down to find the box
            you type into. */}
        <CommentThread taskId={taskId} comments={comments} viewerId={viewerId} scrollList />
      </PopoverContent>
    </Popover>
  );
}

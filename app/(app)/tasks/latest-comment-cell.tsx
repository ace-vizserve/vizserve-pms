"use client";

import { MessageSquare } from "lucide-react";
import { useState } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { richTextToPlainText } from "@/lib/rich-text";
import { CommentThread, type TaskComment } from "./comment-thread";

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
 *
 * ⚠️ A SHEET, NOT A POPOVER — changed 16 Sep 2026, and for the content rather
 * than the taste. A popover is anchored to the cell that opened it, which caps
 * it at the width that still fits beside a table row. That is right for a menu
 * and wrong for a CONVERSATION: a thread with a pasted screenshot in it had to
 * shrink the picture to a thumbnail to fit, and the composer ended up narrower
 * than the comment it was replying to. A sheet is anchored to nothing, so it
 * can simply be wide enough.
 *
 * It also stops this being the third popover on one row — status, priority,
 * comments — which is what made the list read as a menu bar.
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
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
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
      </SheetTrigger>

      {/*
        42rem rather than the primitive's 24rem: wide enough that a landscape
        screenshot is legible in the thread instead of something you have to open
        to read. Still a panel, not a page — the backdrop stays visible on the
        left, so the way out is obvious.

        ⚠️ IT REPEATS `data-[side=right]:` BECAUSE THE PRIMITIVE DOES. `SheetContent`
        ships `data-[side=right]:sm:max-w-sm`, and a plain `sm:max-w-2xl` is a
        DIFFERENT variant key — tailwind-merge sees no conflict, keeps both, and
        the panel stays at 24rem while the class that was supposed to widen it
        sits in the list doing nothing. Matching the variant exactly is what lets
        the merge drop the one underneath. The same trap as `grade-*` vs `bg-*`
        in §1.5 of the design system, from the other direction.
      */}
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate text-sm">{taskTitle}</SheetTitle>
          <SheetDescription className="text-2xs">
            {comments.length === 0
              ? "No comments yet"
              : comments.length === 1
                ? "1 comment"
                : `${comments.length} comments`}
          </SheetDescription>
        </SheetHeader>
        {/* Capped and scrollable: a task with forty comments must not produce a
            popover taller than the window.

            P7-55 moved the cap from a wrapper onto the thread's own list. The
            wrapper version put the COMPOSER inside the scroll region, so
            replying to a long thread meant scrolling back down to find the box
            you type into. */}
        {/* The padding lives here rather than on the panel, so the thread's own
            scroll region reaches the panel's edges and a long conversation does
            not scroll inside an inset box. */}
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <CommentThread taskId={taskId} comments={comments} viewerId={viewerId} scrollList />
        </div>
      </SheetContent>
    </Sheet>
  );
}

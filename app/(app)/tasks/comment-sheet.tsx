"use client";

import { useState, type ReactNode } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { CommentThread, type TaskActivityEvent, type TaskComment } from "./comment-thread";

/**
 * P12-19 — the whole conversation, in a panel, from anywhere.
 *
 * ⚠️ A SHEET IS WHERE A LONG THREAD BELONGS, AND A PAGE IS NOT. That is the
 * lesson of the excess-scroll bug on `/tasks/[id]`, which cost an evening: a
 * `max-height` scroll box in normal page flow hides content from the READER
 * while the layout above it still accounts for the full size, and the surplus
 * comes out as a page that scrolls into empty space. A sheet has a DEFINITE
 * height — the window — so a scroll region inside it is bounded by something
 * real, and the same thread that broke a page column behaves perfectly here.
 *
 * So the rule this component exists to enforce: a page caps by COUNT and links
 * here; scrolling a thread happens in a sheet.
 *
 * ⚠️ IT WAS INSIDE `latest-comment-cell.tsx` UNTIL THE TASK PAGE NEEDED IT TOO.
 * Copying it would have been the third implementation of one conversation — see
 * `CommentThread`'s own note on why there is only ever one of those.
 */
export function CommentSheet({
  taskId,
  taskTitle,
  comments,
  viewerId,
  events = [],
  className,
  children,
}: {
  taskId: string;
  taskTitle: string;
  /** The whole thread. Empty is a real and common state. */
  comments: TaskComment[];
  viewerId: string;
  /**
   * QA returns and client replies, for the caller that has them. The list row
   * passes none — there the cell is about the conversation, and the moves are a
   * column of their own.
   */
  events?: TaskActivityEvent[];
  /** What the trigger looks like. Every caller draws its own. */
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const total = comments.length + events.length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className={className}>{children}</SheetTrigger>

      {/*
        42rem rather than the primitive's 24rem: wide enough that a landscape
        screenshot is legible in the thread instead of something you have to open
        to read. Still a panel, not a page — the backdrop stays visible on the
        left, so the way out is obvious.

        ⚠️ IT REPEATS `data-[side=right]:` BECAUSE THE PRIMITIVE DOES.
        `SheetContent` ships `data-[side=right]:sm:max-w-sm`, and a plain
        `sm:max-w-2xl` is a DIFFERENT variant key — tailwind-merge sees no
        conflict, keeps both, and the panel stays at 24rem while the class that
        was supposed to widen it sits in the list doing nothing. Matching the
        variant exactly is what lets the merge drop the one underneath.
      */}
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate text-sm">{taskTitle}</SheetTitle>
          <SheetDescription className="text-2xs">
            {total === 0 ? "Nothing said yet" : total === 1 ? "1 entry" : `${total} entries`}
          </SheetDescription>
        </SheetHeader>

        {/* `min-h-0 flex-1` IS THE HEIGHT THE THREAD INSIDE FILLS. The sheet is
            a full-height flex column, this takes what is left under the header,
            and `fillHeight` below hands it to the LIST — so a task with forty
            comments scrolls inside the panel and one with two does not leave a
            screenful of nothing under it.

            ⚠️ `flex flex-col`, NOT A PLAIN BLOCK. The thread fills this with
            `flex-1`, and a flex child needs a flex parent to fill — as a block
            it took its content height and the list ran past the bottom of the
            panel, where this `overflow-hidden` cut it off with no scrollbar.

            ⚠️ THE SCROLL REGION IS THE LIST, NEVER THIS WRAPPER (P7-55). The
            wrapper version put the COMPOSER inside the scroll region, so
            replying to a long thread meant scrolling back down to find the box
            you type into. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <CommentThread
            fillHeight
            taskId={taskId}
            comments={comments}
            events={events}
            viewerId={viewerId}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

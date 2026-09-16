"use client";

import { useCallback, useEffect, useRef } from "react";

import { useTaskImageLightbox } from "@/components/task-image-lightbox";
import { RICH_TEXT_CLASS } from "@/components/ui/rich-text";
import { isTaskImageSrc } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

/**
 * P7-67 — a comment body, and the way into the picture inside it.
 *
 * ⚠️ THE MARKUP IS ALREADY SANITISED and this component does not sanitise it.
 * `page.tsx` and `latest-comment-cell.tsx` run every body through
 * `sanitizeRichText` where the rows are read; this file is `"use client"`, so
 * importing the sanitiser here would pull `sanitize-html` into the browser
 * bundle of every page that draws a thread. The markup is trusted because of
 * where it came from, not because of anything done below — if you ever pass a
 * body in from somewhere new, sanitise it there.
 *
 * ⚠️ THE IMAGES ARE MADE INTERACTIVE HERE, NOT IN THE SANITISER, and that is
 * the point of the split. An `img` carrying `role="button"` in the STORED
 * markup would announce itself as a control on every surface that renders a
 * body — including `<RichText>`, a server component with no handler attached —
 * and a control that does nothing is worse than a picture that does nothing.
 * The attributes are added by the effect below, which only runs where the
 * handler exists.
 *
 * ⚠️ `role="button"` REPLACES THE IMAGE ROLE, DELIBERATELY. The alt text then
 * reads as the control's accessible name, so a screen reader announces
 * "Screenshot 2026-09-16.png, button" — the name survives, and the fact that it
 * can be opened is stated rather than implied. This is what wrapping each image
 * in a `<button>` would produce, without rewriting stored markup to do it.
 *
 * ⚠️ AND THE DIALOG IS NOT RENDERED HERE. It is one instance in the layout —
 * `components/task-image-lightbox.tsx` has the account of why, and it is not a
 * matter of taste: a dialog mounted inside the comment overlay is unmounted by
 * its own opening.
 */
export function CommentBody({ html, className }: { html: string; className?: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const showImage = useTaskImageLightbox();

  /*
   * ⚠️ IT RE-RUNS ON `html`, AND IT MUST. An edited comment replaces the whole
   * subtree — `dangerouslySetInnerHTML` does not patch it — so every image node
   * is new and the attributes set on the old ones went with them.
   */
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;

    for (const image of root.querySelectorAll("img")) {
      // `getAttribute`, not `.src`: the property resolves to an absolute URL,
      // which would never match the relative path the allowlist describes.
      if (!isTaskImageSrc(image.getAttribute("src"))) continue;

      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-haspopup", "dialog");
    }
  }, [html]);

  /*
   * Delegated, rather than a listener per image. A thread can hold a dozen
   * bodies with a dozen pictures between them, and this way an edit that
   * replaces the markup cannot leave a stale listener behind — there is only
   * ever one, on a node this component owns.
   */
  const open = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof HTMLImageElement)) return false;
      if (!isTaskImageSrc(target.getAttribute("src"))) return false;

      showImage({
        src: target.getAttribute("src")!,
        alt: target.getAttribute("alt") || "Image",
        // `naturalWidth` rather than the attribute: by the time anybody clicks,
        // the image has decoded and the browser knows the truth. The attribute
        // is what the server measured, and the two agree — but only one of them
        // is still right if a body was hand-edited in SQL.
        width: target.naturalWidth || null,
        height: target.naturalHeight || null,
      });

      return true;
    },
    [showImage],
  );

  return (
    <div
      ref={bodyRef}
      data-slot="comment-body"
      className={cn(RICH_TEXT_CLASS, className)}
      onClick={(event) => {
        if (open(event.target)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        // The two keys a `role="button"` is required to answer. Space is
        // `event.key === " "`, and it also scrolls the page, hence the
        // `preventDefault` on the branch that handles it.
        if (event.key !== "Enter" && event.key !== " ") return;
        if (open(event.target)) event.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

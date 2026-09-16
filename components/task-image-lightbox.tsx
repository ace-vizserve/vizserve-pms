"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * P7-67 — the enlarged view of an image in a comment, mounted ONCE, above
 * everything that can close.
 *
 * ⚠️ IT LIVES IN THE LAYOUT BECAUSE IT CANNOT LIVE IN THE THREAD. The first
 * version rendered the dialog inside `CommentBody`, which is inside the comment
 * overlay on `/tasks`. Opening the dialog portals it to `<body>` and moves focus
 * into it; the overlay reads focus leaving as a dismissal and closes; closing it
 * unmounts `CommentBody` — and the dialog, which had just opened, goes with it.
 * The symptom is a click that appears to do nothing at all, which is why it took
 * a second look: nothing is broken about the click.
 *
 * ⚠️ SO THE STATE HAS TO OUTLIVE THE THING THAT WAS CLICKED. Anything mounted
 * inside a popover, a sheet or a dialog has the same problem, and would keep
 * having it after any of them is swapped for another. One provider at the root
 * of the authenticated area is the shape that stops it recurring — a thread
 * asks for a picture to be shown and does not own the showing.
 */

type ShownImage = {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
};

const TaskImageLightboxContext = createContext<((image: ShownImage) => void) | null>(null);

/**
 * Show a task image full size.
 *
 * Throws without a provider rather than returning a no-op: a missing provider
 * is a picture that silently does nothing when clicked, which is exactly the
 * bug this file exists to fix and is not one to reintroduce quietly.
 */
export function useTaskImageLightbox() {
  const show = useContext(TaskImageLightboxContext);

  if (!show) {
    throw new Error(
      "useTaskImageLightbox needs <TaskImageLightboxProvider>, which the (app) layout mounts.",
    );
  }

  return show;
}

export function TaskImageLightboxProvider({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState<ShownImage | null>(null);
  const [actualSize, setActualSize] = useState(false);

  const show = useCallback((image: ShownImage) => {
    // Back to "fit" for every opening, in the same event that opens it. As an
    // effect on `shown` this is a `setState` during an effect — a second render
    // of a dialog that has already painted, and a lint error besides.
    setActualSize(false);
    setShown(image);
  }, []);

  /*
   * ⚠️ MEMOISED, AND IT MATTERS MORE THAN USUAL. This provider wraps every
   * authenticated page; a value that changed identity on each render would
   * re-render the whole shell each time somebody opened a picture.
   */
  const value = useMemo(() => show, [show]);

  return (
    <TaskImageLightboxContext.Provider value={value}>
      {children}

      <ImageLightbox
        image={shown}
        actualSize={actualSize}
        onToggleSize={() => setActualSize((on) => !on)}
        onClose={() => setShown(null)}
      />
    </TaskImageLightboxContext.Provider>
  );
}

/**
 * THE LARGE VIEW IS THE DEFAULT, and "Actual size" is the extra rather than the
 * point. The whole picture scaled to a 95vh dialog is what somebody wants
 * ninety-nine times out of a hundred; 1:1 in a scrolling box is for the
 * remaining case, a 2,560px screenshot whose text is still too small to read
 * even at 82vh.
 *
 * The toggle only appears when the two differ — an image already smaller than
 * the fitted box renders identically either way, so offering the choice there
 * would be a control that does nothing.
 */
function ImageLightbox({
  image,
  actualSize,
  onToggleSize,
  onClose,
}: {
  image: ShownImage | null;
  actualSize: boolean;
  onToggleSize: () => void;
  onClose: () => void;
}) {
  const known = image?.width && image.height ? { w: image.width, h: image.height } : null;

  return (
    <Dialog open={Boolean(image)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        /*
         * AS BIG AS THE WINDOW SENSIBLY ALLOWS. This dialog has one job — show
         * the picture larger than the thread could — so the default view is the
         * large one rather than a modest step up from a thumbnail.
         *
         * `95vw` and `95vh` rather than filling the viewport: the sliver of
         * backdrop left around it is what says "click out of this", and a
         * dialog flush to the edges reads as a page you have navigated to.
         * `90rem` stops it stretching absurdly wide on an ultrawide monitor,
         * where a 3,000px-wide dialog for a 1,200px image is all frame.
         */
        className="max-h-[95vh] w-auto max-w-[min(95vw,90rem)] gap-3 sm:max-w-[min(95vw,90rem)]">
        <DialogHeader className="pr-8">
          {/* The alt text is the filename the author pasted. Truncated rather
              than wrapped — a long filename must not push the picture down. */}
          <DialogTitle className="truncate text-sm">{image?.alt ?? "Image"}</DialogTitle>
          <DialogDescription className="text-2xs tabular-nums">
            {known ? `${known.w} × ${known.h} pixels` : "Full size"}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            "flex min-h-0 justify-center rounded-md border bg-muted",
            actualSize ? "overflow-auto" : "overflow-hidden",
          )}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image.src}
              alt={image.alt}
              className={cn(
                // 82vh leaves room for the title and the footer inside a 95vh
                // dialog, and nothing else. The fitted view IS the large view.
                actualSize ? "max-w-none" : "max-h-[82vh] w-auto max-w-full object-contain",
              )}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          {known ? (
            <Button variant="ghost" size="sm" onClick={onToggleSize}>
              {actualSize ? "Fit to window" : "Actual size"}
            </Button>
          ) : null}

          {/*
            A LINK, NOT A BUTTON, because it navigates — §2.1. It opens the route
            that signs a fresh URL, so "open in a new tab" works for as long as
            the reader is signed in, and the address in that tab is not a
            signature that dies in sixty seconds.
          */}
          {image ? (
            <a
              href={image.src}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline underline-offset-2">
              Open in a new tab
            </a>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

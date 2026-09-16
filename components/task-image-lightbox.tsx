"use client";

import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

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

const TaskImageLightboxContext = createContext<
  ((image: ShownImage) => void) | null
>(null);

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

export function TaskImageLightboxProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState<ShownImage | null>(null);
  const [actualSize, setActualSize] = useState(false);

  /*
   * ⚠️ THE ZOOM LIVES UP HERE WITH `actualSize`, not in the dialog that uses it,
   * and for the same reason as the line below: both have to be BACK TO NEUTRAL
   * in the event that opens a picture. Held in the dialog it could only be reset
   * by an effect watching `image`, which is a `setState` during an effect — a
   * second render of a dialog that has already painted, and the lint rule this
   * file already documents once.
   */
  const [zoom, setZoom] = useState<Zoom>(FITTED);

  const show = useCallback((image: ShownImage) => {
    // Back to "fit" for every opening, in the same event that opens it. Zoom is
    // a way of LOOKING at one image, not a setting: carried over, the next
    // picture would open on a corner of itself with no clue why.
    setActualSize(false);
    setZoom(FITTED);
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
        zoom={zoom}
        onZoom={setZoom}
        onToggleSize={() => {
          // The two views are two ways of magnifying one picture, so switching
          // between them starts the other from neutral rather than carrying a
          // 4× offset into a scroll box where it means something else.
          setZoom(FITTED);
          setActualSize((on) => !on);
        }}
        onClose={() => setShown(null)}
      />
    </TaskImageLightboxContext.Provider>
  );
}

/**
 * ⚠️ THE FITTED VIEW WAS BRIEFLY BLOWN UP TO 1.35× and it is not any more.
 * `max-height` on an `<img>` only ever SHRINKS one, so a 366px screenshot
 * opened at the same 366px it was drawn at in the thread — which is a real
 * complaint, and scaling every small picture up by a third was the wrong answer
 * to it: it softened the text on the ones already big enough to read. The wheel
 * below does the same job on demand, at whatever magnification the reader
 * actually wants, and only where they point it.
 */

/** Zoom bounds. 1 is the fitted view; nothing zooms out past it. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

/**
 * How fast a wheel notch magnifies. Exponential rather than additive, so a step
 * feels the same at 1× as it does at 4× — a fixed +0.25 crawls when you are
 * close in and lurches when you are far out.
 */
const ZOOM_RATE = 0.0015;

type Zoom = { scale: number; x: number; y: number };

const FITTED: Zoom = { scale: 1, x: 0, y: 0 };

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
  zoom,
  onZoom,
  onToggleSize,
  onClose,
}: {
  image: ShownImage | null;
  actualSize: boolean;
  /** Held by the provider, which resets it — see the note where it is declared. */
  zoom: Zoom;
  onZoom: Dispatch<SetStateAction<Zoom>>;
  onToggleSize: () => void;
  onClose: () => void;
}) {
  const known =
    image?.width && image.height ? { w: image.width, h: image.height } : null;

  const imageRef = useRef<HTMLImageElement | null>(null);

  /*
   * ⚠️ A NATIVE, NON-PASSIVE LISTENER, NOT `onWheel`. React registers its wheel
   * handler on the root as PASSIVE, where `preventDefault()` does nothing but
   * log a warning — so the zoom would work and the page behind the dialog would
   * scroll at the same time.
   *
   * ⚠️ AND IT IS ATTACHED BY A CALLBACK REF, NOT BY AN EFFECT OVER `useRef`.
   * That is the difference between this working and this silently doing nothing,
   * which is how it shipped first: the frame lives inside `DialogContent`, which
   * is PORTALED AND ONLY MOUNTS WHILE A PICTURE IS OPEN. On this component's
   * first render — every render, in fact, until one is — `frameRef.current` is
   * null, the effect returned early, and its dependencies never changed
   * afterwards, so it never ran again. The listener was never attached to
   * anything.
   *
   * A callback ref is called BY React the moment the node exists and again with
   * null when it goes, which is exactly the lifecycle a portalled node has.
   * React 19 runs the function it returns as the cleanup, so the listener is
   * removed with the node rather than outliving it.
   */
  const frameRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;

      // Bound into a const the handler closes over: TypeScript drops the
      // narrowing from the guard above once a function DECLARATION is in the
      // way, because it cannot know when that function will be called.
      const frame = node;

      function onWheel(event: WheelEvent) {
        // At actual size the frame is a scroll box and the wheel belongs to it.
        // Two things claiming the same gesture is worse than either alone.
        if (actualSize) return;

        event.preventDefault();

        const img = imageRef.current;

        if (!img) return;

        const rect = frame.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;

        onZoom((current) => {
          /*
           * UP ZOOMS IN, DOWN ZOOMS OUT — the direction every map, canvas and
           * image viewer uses, so the hand already knows it.
           *
           * `deltaY` is POSITIVE scrolling down, hence the minus: scrolling away
           * from you has to make the exponent positive to magnify. The sign is
           * the whole of the convention; nothing else here changes with it.
           */
          const next = Math.min(
            MAX_ZOOM,
            Math.max(
              MIN_ZOOM,
              current.scale * Math.exp(-event.deltaY * ZOOM_RATE),
            ),
          );

          if (next === current.scale) return current;
          // Back to fitted means back to centred — the frame's own `justify-center`
          // does that, and a leftover offset would hold the picture off to one side.
          if (next === MIN_ZOOM) return FITTED;

          /*
           * KEEP THE PIXEL UNDER THE CURSOR UNDER THE CURSOR.
           *
           * `offsetLeft/Top` is the image's UNTRANSFORMED position inside the
           * frame — the transform does not move it, which is exactly why this
           * arithmetic stays stable across steps where reading
           * `getBoundingClientRect()` would drift.
           *
           * Screen position of image point p is `offset + translate + p × scale`,
           * so p under the cursor is `(cursor − offset − translate) / scale`, and
           * the new translate is whatever puts that same p back under it.
           */
          const px = (cx - img.offsetLeft - current.x) / current.scale;
          const py = (cy - img.offsetTop - current.y) / current.scale;

          return {
            scale: next,
            x: cx - img.offsetLeft - px * next,
            y: cy - img.offsetTop - py * next,
          };
        });
      }

      frame.addEventListener("wheel", onWheel, { passive: false });
      return () => frame.removeEventListener("wheel", onWheel);
    },
    [actualSize, onZoom],
  );

  const zoomed = zoom.scale > MIN_ZOOM;

  /**
   * The grab in progress, or null.
   *
   * ⚠️ A REF, NOT STATE, for everything the move handler reads. A pointer sends
   * a move event per frame; holding the origin in state would re-render the
   * dialog to store a number nothing draws. Only `dragging` below is state, and
   * only because the CURSOR changes.
   */
  const dragRef = useRef<{
    pointer: number;
    fromX: number;
    fromY: number;
    /** Where the picture was when the grab started — deltas are added to this. */
    atX: number;
    atY: number;
  } | null>(null);

  const [dragging, setDragging] = useState(false);

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    // Nothing to pan at 1× — the whole picture is already in frame — and at
    // actual size the scroll box does this natively and better.
    if (actualSize || !zoomed || event.button !== 0) return;

    /*
     * ⚠️ POINTER CAPTURE, and the drag falls apart without it. The pointer
     * leaves this box constantly while panning — that is what panning IS — and
     * an uncaptured pointer stops sending moves the moment it does, leaving the
     * picture stuck mid-gesture with the button still held.
     */
    event.currentTarget.setPointerCapture(event.pointerId);

    dragRef.current = {
      pointer: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      atX: zoom.x,
      atY: zoom.y,
    };

    setDragging(true);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;

    if (!drag || drag.pointer !== event.pointerId) return;

    /*
     * ⚠️ MEASURED FROM WHERE THE GRAB STARTED, never accumulated per event.
     * Adding each frame's delta to the last position drifts — a dropped event
     * or a coalesced one is lost for good — and it makes the picture slide when
     * the pointer is still. From the origin, every frame is self-correcting.
     *
     * 1:1 with the pointer, NOT divided by the scale: the reader is dragging
     * the picture they can see, not the pixels underneath it.
     */
    onZoom((current) => ({
      ...current,
      x: drag.atX + (event.clientX - drag.fromX),
      y: drag.atY + (event.clientY - drag.fromY),
    }));
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointer !== event.pointerId) return;

    dragRef.current = null;
    setDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

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
        className="max-h-[95vh] w-auto max-w-[min(95vw,90rem)] gap-3 sm:max-w-[min(95vw,90rem)]"
      >
        <DialogHeader className="pr-8">
          {/* The alt text is the filename the author pasted. Truncated rather
              than wrapped — a long filename must not push the picture down. */}
          <DialogTitle className="truncate text-sm">
            {image?.alt ?? "Image"}
          </DialogTitle>
          <DialogDescription className="text-2xs tabular-nums">
            {[
              known ? `${known.w} × ${known.h} pixels` : "Full size",
              // The magnification, only once it is not 1 — and the hint only
              // while it is, because a wheel gesture on a picture is not
              // something anybody thinks to try unless told.
              actualSize
                ? null
                : zoomed
                  ? `zoomed ${Math.round(zoom.scale * 100)}%`
                  : "scroll to zoom",
              // Said only while it is true, and it is the half nobody discovers:
              // a picture that can be dragged looks exactly like one that cannot.
              zoomed && !actualSize ? "drag to move" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={frameRef}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          // A drag interrupted by the system — a context menu, a window switch,
          // the browser taking the pointer for its own gesture — never sends
          // `pointerup`. Without this the picture stays stuck to a pointer that
          // is no longer down.
          onPointerCancel={endDrag}
          className={cn(
            // `relative`, so the image's `offsetLeft/Top` are measured against
            // THIS box — the zoom arithmetic above depends on it.
            "relative flex min-h-0 justify-center rounded-md border bg-muted",
            actualSize ? "overflow-auto" : "overflow-hidden",
            // ⚠️ THE CURSOR IS ON THE FRAME, NOT THE IMAGE, once there is
            // something to drag: at 4× the picture overflows this box, so the
            // pointer spends most of a pan over frame rather than over image,
            // and a grab cursor that vanished at the edges would report the
            // drag as having ended when it had not.
            !actualSize && zoomed && (dragging ? "cursor-grabbing" : "cursor-grab"),
          )}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imageRef}
              src={image.src}
              alt={image.alt}
              /*
               * ⚠️ `draggable={false}` IS LOAD-BEARING. An image is natively
               * draggable, so without this the browser starts its own
               * drag-and-drop the moment the pointer moves — it swallows the
               * pointer events the pan needs and leaves a ghost of the picture
               * trailing the cursor.
               */
              draggable={false}
              /*
               * `0 0` ORIGIN, deliberately. With the default centre origin the
               * translate the wheel computes would be measured from a moving
               * point and the picture would slide away from the cursor as it
               * grew. From the top-left the maths above is plain arithmetic.
               *
               * No transition: a wheel sends a stream of events, and easing each
               * one leaves the zoom lagging a second behind the hand.
               */
              style={
                actualSize
                  ? undefined
                  : {
                      transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                      transformOrigin: "0 0",
                      willChange: zoomed ? "transform" : undefined,
                    }
              }
              className={cn(
                // Never selectable: a drag across an image selects it, and a
                // blue wash over the picture is not what the gesture asked for.
                "select-none",
                actualSize
                  ? "max-w-none"
                  : cn(
                      "max-h-[82vh] w-auto max-w-full object-contain",
                      // The affordance at 1×: the cursor is the only thing that
                      // says the wheel does something here. Once zoomed, the
                      // frame's grab cursor takes over — panning is the more
                      // useful thing to advertise, and two cursors arguing over
                      // one box is worse than either.
                      zoomed ? null : "cursor-zoom-in",
                    ),
              )}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          {/* The way back, for a reader who has zoomed into a corner and cannot
              find the rest of the picture. Scrolling the other way does it too;
              this is the one that does not require knowing that. */}
          {zoomed && !actualSize ? (
            <Button variant="ghost" size="sm" onClick={() => onZoom(FITTED)}>
              Reset zoom
            </Button>
          ) : null}

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
              className="text-xs text-primary underline underline-offset-2"
            >
              Open in a new tab
            </a>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

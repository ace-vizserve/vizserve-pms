"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";
import { motion, useReducedMotion } from "motion/react";

import type { Role } from "@/lib/auth/roles";
import {
  answerQuestion,
  GUIDE_SUGGESTIONS,
  planFor,
  reachableHrefs,
  stepsFor,
  tourForPage,
  type TourStep,
} from "@/lib/assistant/guide";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The assistant — ask where something is and it shows you: it flies to the
 * sidebar row, opens the page, points at each control while a speech bubble
 * says what it does, then flies back to its corner. The matching and the
 * script are `lib/assistant/guide.ts`; this is only the choreography.
 *
 * ⚠️ THE TOUR LIVES IN A MODULE-LEVEL STORE, NOT IN COMPONENT STATE. `/` is
 * outside the `(app)` shell, so this component is mounted twice — once there,
 * once in the shell — and a tour that crosses between them unmounts the copy
 * that started it. A client-side navigation keeps the module alive, so the copy
 * that mounts on arrival carries on from the same step.
 */

const NAME = "Assistant";
/** The character's box, in px. The launcher is a little larger around it. */
const SIZE = 48;
const BUBBLE_WIDTH = 288;
const GAP = 8;

type Tour = {
  /** Tells one tour from the next, so a position is never carried across. */
  id: number;
  steps: TourStep[];
  index: number;
  /** Navigate on reaching this step, before pointing at it. */
  navigateAt: number | null;
  href: string | null;
  /** The path left behind while navigating; null once arrived. */
  leaving: string | null;
  /** Opened after the character is home — see `GuideDestination.then`. */
  then: string | null;
  returning: boolean;
};

let current: Tour | null = null;
const listeners = new Set<() => void>();

function setTour(next: Tour | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useTour(): Tour | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

function nextStep() {
  if (!current || current.returning) return;
  // A `click` step presses its target on the way out — opening the dialog the
  // next steps point inside.
  const leaving = current.steps[current.index];
  if (leaving?.click && leaving.target) findVisible(leaving.target)?.click();
  if (current.index + 1 >= current.steps.length) endTour();
  else setTour({ ...current, index: current.index + 1 });
}

/** Fly home. The component lands it once the character is back. */
function endTour() {
  if (current && !current.returning) setTour({ ...current, returning: true });
}

/** Long enough to read once it has finished typing: a floor, then per word. */
function readingTime(text: string): number {
  return Math.max(1800, text.split(/\s+/).length * 260);
}

const TYPE_MS = 22;
/** Streamed sections and redirects: look for a target this long, then talk anyway. */
const FIND_TIMEOUT_MS = 2000;
const ARRIVAL_TIMEOUT_MS = 3000;
/** Shorter: an optional control that is not there yet usually never will be. */
const OPTIONAL_TIMEOUT_MS = 900;

/** Past a step that has nothing to point at — unless the tour already moved on. */
function skipStep(step: TourStep) {
  if (!current || current.returning || current.steps[current.index] !== step) return;
  if (current.index + 1 >= current.steps.length) endTour();
  else setTour({ ...current, index: current.index + 1 });
}

/** Present AND laid out — a folded sidebar's links exist with a zero box. */
function findVisible(selector: string): HTMLElement | null {
  let nodes: NodeListOf<HTMLElement>;
  try {
    nodes = document.querySelectorAll<HTMLElement>(selector);
  } catch {
    return null;
  }
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return node;
  }
  return null;
}

type Point = { x: number; y: number };
type Box = { top: number; left: number; width: number; height: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where the character sits to point at a box: at its lower-left corner, the
 * way a cursor rests on a link. A box taller than half the screen is pointed
 * at near its top instead, or the character would land on whatever is below.
 */
function pointAt(box: Box): Point {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchorY = box.height > vh / 2 ? box.top + 32 : box.top + box.height - 8;
  return {
    x: clamp(box.left + Math.min(24, box.width / 2) - 6, GAP, vw - SIZE - GAP),
    y: clamp(anchorY, GAP, vh - SIZE - GAP),
  };
}

/** The bubble to the right of the character, or to its left when that is off-screen. */
function bubbleFor(point: Point): Point {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const right = point.x + SIZE + GAP;
  const x = right + BUBBLE_WIDTH <= vw - GAP ? right : point.x - BUBBLE_WIDTH - GAP;
  return { x: clamp(x, GAP, vw - BUBBLE_WIDTH - GAP), y: clamp(point.y - 4, GAP, vh - 140) };
}

function toBox(rect: DOMRect): Box {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function Assistant({
  role,
  isHr,
  isDeptAdmin,
}: {
  role: Role;
  isHr: boolean;
  isDeptAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion() ?? false;

  const reachable = useMemo(() => reachableHrefs(role, { isHr, isDeptAdmin }), [role, isHr, isDeptAdmin]);
  const suggestions = useMemo(
    () => GUIDE_SUGGESTIONS.filter((s) => answerQuestion(s.question, reachable).kind === "go"),
    [reachable],
  );

  const [open, setOpen] = useState(false);
  const [hasPageTour, setHasPageTour] = useState(false);
  const [question, setQuestion] = useState("");
  const tour = useTour();
  const step = tour && !tour.returning ? tour.steps[tour.index] : null;

  // ---- where home is: the launcher in the corner -------------------------
  const launcher = useRef<HTMLButtonElement>(null);
  const [home, setHome] = useState<Point | null>(null);
  useLayoutEffect(() => {
    function measure() {
      const rect = launcher.current?.getBoundingClientRect();
      if (rect) setHome({ x: rect.left + (rect.width - SIZE) / 2, y: rect.top + (rect.height - SIZE) / 2 });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // ---- navigation: leave, then wait to arrive ----------------------------
  useEffect(() => {
    if (!tour || tour.returning || tour.leaving !== null) return;
    if (tour.navigateAt !== tour.index || !tour.href) return;
    if (tour.href === pathname) {
      setTour({ ...tour, navigateAt: null });
      return;
    }
    setTour({ ...tour, navigateAt: null, leaving: pathname });
    router.push(tour.href);
  }, [tour, pathname, router]);

  const arriving = tour?.leaving != null;
  useEffect(() => {
    if (!tour || tour.leaving === null) return;
    if (tour.leaving !== pathname) {
      setTour({ ...tour, leaving: null });
      return;
    }
    // A redirect can land somewhere other than the href; never wait forever.
    const timer = window.setTimeout(() => current && setTour({ ...current, leaving: null }), ARRIVAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [tour, pathname]);

  // ---- pointing: find the target, scroll to it, keep up with the page ----
  // `seen` is keyed to the step it belongs to, so a new step starts unlocated
  // by derivation rather than by an effect resetting it.
  const [seen, setSeen] = useState<{ step: TourStep; box: Box | null } | null>(null);
  const [pointed, setPointed] = useState<{ tour: number; at: Point } | null>(null);
  const point = tour && pointed?.tour === tour.id ? pointed.at : null;
  const waitingToNavigate = tour?.navigateAt === tour?.index;
  const pointing = step !== null && !arriving && !waitingToNavigate;
  const located = step !== null && (!step.target || seen?.step === step);
  const box = step !== null && seen?.step === step ? seen.box : null;

  useEffect(() => {
    if (!pointing || !step?.target) return;
    const target = step.target;
    let element: HTMLElement | null = null;
    let cancelled = false;

    const update = () => {
      if (!element) return;
      const measured = toBox(element.getBoundingClientRect());
      setSeen({ step, box: measured });
      if (current) setPointed({ tour: current.id, at: pointAt(measured) });
    };

    const started = performance.now();
    const look = () => {
      if (cancelled) return;
      element = findVisible(target);
      if (element) {
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
        // Measure after the scroll has had a moment to settle, then follow it.
        window.setTimeout(() => {
          if (!cancelled) update();
        }, reduceMotion ? 0 : 320);
        return;
      }
      if (performance.now() - started > (step.optional ? OPTIONAL_TIMEOUT_MS : FIND_TIMEOUT_MS)) {
        // Not here for this person. An optional step is about that control, so
        // it is skipped; any other is said without pointing.
        if (step.optional) skipStep(step);
        else setSeen({ step, box: null });
        return;
      }
      window.setTimeout(look, 120);
    };
    look();

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelled = true;
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [pointing, step, reduceMotion]);

  // ---- talking: type the line, hold it, move on --------------------------
  // Keyed to the step like `seen`, so a new line starts from nothing.
  const [typing, setTyping] = useState<{ step: TourStep | null; count: number }>({ step: null, count: 0 });
  // Keyed to the step, like `seen`: a pause belongs to the line being read.
  // Pressing Next leaves the mouse on the bubble, and a modal step makes the
  // bubble ignore the pointer — so its mouseleave never comes, and a plain
  // boolean paused the tour inside the dialog for good.
  const [hoveredStep, setHoveredStep] = useState<TourStep | null>(null);
  const hovering = step !== null && !step.modal && hoveredStep === step;
  const talking = pointing && located;
  const text = step?.text ?? "";
  const typed = reduceMotion ? text.length : typing.step === step ? typing.count : 0;
  const done = typed >= text.length;

  useEffect(() => {
    if (!talking || done) return;
    const timer = window.setTimeout(() => setTyping({ step, count: typed + 1 }), TYPE_MS);
    return () => window.clearTimeout(timer);
  }, [talking, done, step, typed]);

  useEffect(() => {
    if (!talking || !done || hovering) return;
    const timer = window.setTimeout(nextStep, readingTime(text));
    return () => window.clearTimeout(timer);
  }, [talking, done, hovering, text]);

  // Escape ends the tour from anywhere.
  const touring = tour !== null;
  useEffect(() => {
    if (!touring) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") endTour();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [touring]);

  // ---- the character: animated while it works, still otherwise ----------
  const [launcherPlayer, setLauncherPlayer] = useState<DotLottie | null>(null);
  useEffect(() => {
    if (!launcherPlayer) return;
    if (open && !reduceMotion) launcherPlayer.play();
    else launcherPlayer.pause();
  }, [launcherPlayer, open, reduceMotion]);

  /** Back in the corner: clear the tour and open whatever it promised. */
  const landed = useCallback(() => {
    if (!current?.returning) return;
    const then = current.then;
    setTour(null);
    if (then) router.push(then);
  }, [router]);

  // With no flight to finish (reduced motion, or no home measured yet),
  // nothing would ever call `landed` — so land at once.
  const returning = tour?.returning === true;
  useEffect(() => {
    if (returning && (reduceMotion || !home)) landed();
  }, [returning, reduceMotion, home, landed]);

  function ask(input: string) {
    const page = tourForPage(pathname, new URLSearchParams(window.location.search));
    const plan = planFor(input, reachable, pathname, page);
    setOpen(false);
    setQuestion("");

    if (plan.kind === "here") {
      setTour({ id: Date.now(), steps: plan.steps, index: 0, navigateAt: null, href: null, leaving: null, then: null, returning: false });
      return;
    }

    const answer = plan.answer;
    if (answer.kind !== "go" || answer.destination.external) {
      setTour({ id: Date.now(), steps: stepsFor(answer), index: 0, navigateAt: null, href: null, leaving: null, then: null, returning: false });
      return;
    }

    const destination = answer.destination;
    const steps = [...destination.steps];
    let navigateAt: number | null = pathname === destination.href ? null : 0;

    // Show where it lives first, when its row is on screen to point at.
    const row = `[data-slot="sidebar"] a[href="${destination.href}"]`;
    if (navigateAt !== null && findVisible(row)) {
      steps.unshift({ text: `${destination.title} is here in the sidebar.`, target: row });
      navigateAt = 1;
    }

    setTour({
      id: Date.now(),
      steps,
      index: 0,
      navigateAt,
      href: destination.href,
      leaving: null,
      then: destination.then ?? null,
      returning: false,
    });
  }

  const flying = tour !== null;
  const target = tour?.returning ? home : (point ?? home);
  const bubble = talking && target ? bubbleFor(target) : null;

  return (
    <>
      {/* The outline round whatever is being pointed at. Drawn, not applied to
          the element, so no page's own styles are touched. */}
      {talking && box && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-55 rounded-lg outline-2 outline-offset-4 outline-primary transition-all duration-200"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      )}

      {flying && home && target && (
        <motion.div
          animate={{ x: target.x, y: target.y }}
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-60"
          initial={{ x: home.x, y: home.y }}
          onAnimationComplete={() => {
            if (current?.returning) landed();
          }}
          style={{ width: SIZE, height: SIZE }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 140, damping: 20 }}
        >
          <DotLottieReact autoplay={!reduceMotion} className="size-full" loop src="/assets/Assistant.lottie" />
        </motion.div>
      )}

      {bubble && step && (
        <div
          className={cn(
            "fixed z-60 flex flex-col gap-1 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-overlay",
            // Inside a dialog: a press here would read as a click outside it and
            // close the very form being explained.
            step.modal && "pointer-events-none",
          )}
          onMouseEnter={() => setHoveredStep(step)}
          onMouseLeave={() => setHoveredStep(null)}
          style={{ left: bubble.x, top: bubble.y, width: BUBBLE_WIDTH }}
        >
          <span className="text-2xs font-medium text-muted-foreground">{NAME}</span>
          {/* The whole line for a screen reader; the typing is for the eye. */}
          <p aria-live="polite" className="sr-only">
            {text}
          </p>
          {/* The whole line laid out invisibly underneath, so the bubble takes
              its final size at once instead of growing a row at a time. */}
          <p aria-hidden className="grid text-sm leading-snug">
            <span className="invisible col-start-1 row-start-1">{text}</span>
            <span className="col-start-1 row-start-1">{text.slice(0, typed)}</span>
          </p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-2xs tabular-nums text-muted-foreground">
              {tour!.index + 1} of {tour!.steps.length}
            </span>
            {step.modal ? (
              <span className="text-2xs text-muted-foreground">Esc to stop</span>
            ) : (
            <div className="flex gap-1">
              <Button onClick={endTour} size="xs" variant="ghost">
                Skip
              </Button>
              <Button onClick={done ? nextStep : () => setTyping({ step, count: text.length })} size="xs" variant="outline">
                {tour!.index + 1 >= tour!.steps.length ? "Done" : "Next"}
              </Button>
            </div>
            )}
          </div>
        </div>
      )}

      <Popover
        onOpenChange={(next) => {
          // Checked on opening rather than during render: the query decides it
          // on /forms/new, and `window` is not there on the server.
          if (next) setHasPageTour(tourForPage(pathname, new URLSearchParams(window.location.search)) !== null);
          setOpen(next);
        }}
        open={open}
      >
        <PopoverTrigger
          render={
            <Button
              aria-label="Ask the assistant where to go"
              className="fixed right-5 bottom-5 z-40 size-16 rounded-full p-0"
              ref={launcher}
              size="icon-lg"
              variant="outline"
            />
          }
        >
          {/* Hidden, not removed, while its double is out flying: the box keeps
              its place so home stays where it was measured. */}
          <DotLottieReact
            autoplay={false}
            className={flying ? "pointer-events-none size-14 opacity-0" : "pointer-events-none size-14"}
            dotLottieRefCallback={setLauncherPlayer}
            loop
            src="/assets/Assistant.lottie"
          />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80" side="top" sideOffset={8}>
          <PopoverHeader>
            <PopoverTitle className="text-base">Where do you want to go?</PopoverTitle>
            <PopoverDescription>Ask in your own words. I will take you there and show you around.</PopoverDescription>
          </PopoverHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (question.trim()) ask(question);
            }}
          >
            <Label className="sr-only" htmlFor="assistant-question">
              Your question
            </Label>
            <div className="flex gap-2">
              <Input
                autoComplete="off"
                autoFocus
                id="assistant-question"
                maxLength={200}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="e.g. how do I file a leave?"
                value={question}
              />
              <Button disabled={!question.trim()} type="submit">
                Go
              </Button>
            </div>
          </form>
          {(hasPageTour || suggestions.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {hasPageTour && (
                <Button onClick={() => ask("guide me through this page")} size="xs" variant="secondary">
                  Guide me through this page
                </Button>
              )}
              {suggestions.map((suggestion) => (
                <Button key={suggestion.label} onClick={() => ask(suggestion.question)} size="xs" variant="outline">
                  {suggestion.label}
                </Button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}

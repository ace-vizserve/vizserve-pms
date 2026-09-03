"use client";

import { useTheme } from "next-themes";
import * as React from "react";
import { sileo, Toaster as SileoToaster, type SileoPosition } from "sileo";

/**
 * Toasts. `sileo` underneath, and NOTHING ELSE IN THE APP IMPORTS IT.
 *
 * ⚠️ THIS FILE IS THE POINT OF THE EXERCISE, not the library swap. §2 of the
 * design system: a non-Base-UI dependency is a last resort and it gets wrapped
 * in `components/ui/` with our own surface, so no page imports it directly and
 * it can be replaced without touching one. `sonner` was imported by hand in 46
 * files; moving off it meant editing all 46. The next move costs this file.
 *
 * ⚠️ THE SURFACE IS DELIBERATELY SONNER-SHAPED — `toast(message, options)`,
 * with `description`, `duration` and `action: { label, onClick }` — and it is
 * NOT sileo's. sileo takes one options object with a `title` field and calls
 * the button `button: { title, onClick }`. Adapting here rather than at 46 call
 * sites is the difference between an import change and a rewrite, and it means
 * the shape the app speaks is the shape the app chose rather than whichever
 * library is underneath this month.
 *
 * What NO CALL SITE may pass: sileo's `fill`, `roundness`, `icon`, `styles` and
 * `autopilot`. Per-call visual overrides are how a toast system ends up with
 * fourteen looks; those decisions are made once — `fill` and `roundness` in
 * `<Toaster>` below, and everything else as plain CSS on sileo's own
 * `data-sileo-*` attributes in `app/globals.css`. The `styles` classNames it
 * offers were tried and abandoned: they reached the DOM, but Tailwind never
 * emitted the utilities, so the elements carried classes that styled nothing.
 */

/** Everything a call site may pass. Mirrors what `sonner` accepted, minus what nothing used. */
export type ToastOptions = {
  description?: React.ReactNode;
  /** Milliseconds. `null` pins it open. Omit for the library default. */
  duration?: number | null;
  /**
   * One button. `label`/`onClick` rather than sileo's `title`/`onClick`,
   * because `title` already means the toast's own heading and a field that
   * means two things in one object is a bug waiting to be written.
   */
  action?: { label: string; onClick: () => void };
};

type Emit = (options: Parameters<typeof sileo.show>[0]) => string;

function emit(send: Emit, message: React.ReactNode, options?: ToastOptions): string {
  return send({
    // ⚠️ COERCED, because sileo's `title` is a string and ours is whatever a
    // call site had to hand. Every one passes a string today; a stray element
    // would otherwise render as "[object Object]" rather than fail loudly.
    title: typeof message === "string" ? message : String(message ?? ""),
    description: options?.description,
    duration: options?.duration,
    button: options?.action ? { title: options.action.label, onClick: options.action.onClick } : undefined,
  });
}

/**
 * `Object.assign` on a function, so `toast(…)` and `toast.success(…)` are the
 * same import — the shape every call site already uses.
 */
export const toast = Object.assign(
  (message: React.ReactNode, options?: ToastOptions) =>
    /*
     * A PLAIN TOAST IS NOT A SUCCESS. `sileo.show` for the neutral case and
     * `sileo.action` when there is a button, because a toast carrying one is a
     * different thing to look at. Reaching for `success` here would be state
     * conveyed by colour, and wrong colour at that: "You have a new
     * notification" has not succeeded at anything.
     */
    options?.action ? emit(sileo.action, message, options) : emit(sileo.show, message, options),
  {
    success: (message: React.ReactNode, options?: ToastOptions) => emit(sileo.success, message, options),
    error: (message: React.ReactNode, options?: ToastOptions) => emit(sileo.error, message, options),
    info: (message: React.ReactNode, options?: ToastOptions) => emit(sileo.info, message, options),
    warning: (message: React.ReactNode, options?: ToastOptions) => emit(sileo.warning, message, options),

    /** By the id `toast(…)` returned. */
    dismiss: (id: string) => sileo.dismiss(id),
    clear: () => sileo.clear(),
  },
);

/**
 * Top centre — where the app puts them now.
 *
 * It was `top-right`, which on this shell lands under the theme toggle and the
 * sidebar trigger, i.e. over the two controls somebody is most likely to be
 * reaching for when a toast arrives. Centre clears both, and it is where the
 * eye already is after pressing a button in the middle of a page.
 */
const POSITION: SileoPosition = "top-center";

/**
 * ⚠️ `fill` IS AN SVG ATTRIBUTE, NOT A CSS BACKGROUND, and that is what makes
 * the raised surface possible rather than what prevents it.
 *
 * sileo draws the toast as a filtered SVG shape — that is what the gooey morph
 * actually is — and passes `fill` straight through to the path's `fill`
 * attribute. So it takes an SVG PAINT value. `linear-gradient(...)` is CSS
 * syntax and was silently ignored (that shipped once, and the toast fell back
 * to flat white); `url(#id)` is the SVG spelling of the same idea, and it works.
 *
 * §1.5 says a raised object is lighter at the top, where the light is. That is
 * `--gradient-raised`, and `<ToastSurfaceDefs>` below is it, expressed as the
 * `<linearGradient>` an SVG can actually use. The hairline is a real `stroke`
 * on the same path — see `app/globals.css`.
 */
const SURFACE_LIGHT = "url(#vizserve-toast-surface-light)";
const SURFACE_DARK = "url(#vizserve-toast-surface-dark)";

/**
 * The two gradients the surface paints with.
 *
 * ⚠️ IT MUST BE IN THE DOCUMENT FOR `url(#id)` TO RESOLVE, and it has to be
 * OUTSIDE sileo's own tree — sileo unmounts a toast when it exits, and a
 * gradient living inside one would take the definition with it, leaving any
 * toast still on screen painted with nothing. So it renders here, once, beside
 * the Toaster and independent of whether any toast exists.
 *
 * Both are declared always, not switched on the theme: an `id` that appears and
 * disappears is an `id` a mid-animation repaint can miss.
 *
 * ⚠️ THE STOPS ARE `--gradient-RAISED`, NOT `--gradient-surface`, and the
 * difference is the whole point. `--gradient-surface` is #ffffff → #fafcfd —
 * a panel, near-white, and on a white card it is invisible. `--gradient-raised`
 * is #fdfeff → #f1f5f9: its bottom stop is properly grey, so the shape reads as
 * a lit object sitting ON the page rather than as a hole cut in it. A toast is
 * the most raised thing in the product; it takes the raised gradient.
 *
 * Restated as literals because SVG `stop-color` cannot read a CSS custom
 * property that is redefined per theme — it resolves against THIS element, not
 * against the toast, so a token would always give the light value. ⚠️ IF THOSE
 * GRADIENTS CHANGE, THESE CHANGE; they are the only duplicated colours here.
 *
 * `aria-hidden` and zero-sized: it draws nothing, it only defines.
 */
function ToastSurfaceDefs() {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" style={{ position: "absolute" }}>
      <defs>
        {/* x1/y1 → x2/y2 top-to-bottom. The default is LEFT to right, which
            would light the wrong edge. */}
        <linearGradient id="vizserve-toast-surface-light" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fdfeff" />
          <stop offset="100%" stopColor="#f1f5f9" />
        </linearGradient>
        <linearGradient id="vizserve-toast-surface-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#252b37" />
          <stop offset="100%" stopColor="#1c212b" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Between `--radius-lg` (10) and `--radius-xl` (14), picked by eye.
 *
 * A toast is an overlay, so it takes an overlay radius rather than sileo's
 * stock capsule — the collapsed pill was the one shape in the product that
 * belonged to no other component. It is not a token because it is not a value
 * anything else in the system uses: the shape here is 40px tall collapsed, and
 * the radius that reads right on it is not the one that reads right on a card.
 */
const ROUNDNESS = 12;

/**
 * Mounted once, in the root layout, INSIDE `ThemeProvider`.
 *
 * ⚠️ THE THEME IS PASSED EXPLICITLY RATHER THAN LEFT ON "system". This app
 * switches theme by CLASS through `next-themes`, so a viewer who has chosen
 * Dark against a light OS would get light toasts over a dark app — sileo's
 * "system" reads the OS, which is not what the toggle in the header means.
 *
 * `resolvedTheme` is undefined until after hydration, which is why it falls
 * back to "system" rather than to "light": on the first paint the OS guess is
 * right far more often than a coin flip, and it is corrected within a frame.
 * The FILL has no such fallback available — it names one gradient, not a media
 * query — so it follows `resolvedTheme` directly and is simply the light one
 * until the theme resolves. A toast cannot fire that early.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  return (
    <>
      <ToastSurfaceDefs />
      <SileoToaster
        position={POSITION}
        theme={dark ? "dark" : resolvedTheme === "light" ? "light" : "system"}
        options={{
          fill: dark ? SURFACE_DARK : SURFACE_LIGHT,
          roundness: ROUNDNESS,
        }}
      />
    </>
  );
}

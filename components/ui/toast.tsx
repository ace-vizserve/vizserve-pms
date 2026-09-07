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
 * fourteen looks; those decisions are made once, in `<Toaster>` below.
 *
 * ⚠️ THE APP NO LONGER RETARGETS sileo's INTERNALS. `app/globals.css` carried a
 * ~310-line block mapping every `data-sileo-*` part onto this system's tokens —
 * the state-tinted surface, the stroke, the three drop shadows, the badge chip
 * and every line of type, all of it `!important` to win against a stylesheet
 * sileo injects from JavaScript at mount. It is gone. The toast is a plain black
 * card now, and its entire appearance is the four lines passed below.
 *
 * That block is not to be rebuilt piecemeal. It existed because sileo ships no
 * theming contract beyond a handful of variables, and fighting that from a
 * stylesheet is what produced 310 lines of `!important` in the first place.
 * Anything the four lines below cannot express is a reason to reconsider the
 * library, not to reopen that file.
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
 *
 * The FILL does not depend on any of that. It is black in both themes — which is
 * the point of a black toast: on the light app it is the highest-contrast thing
 * on the page, and on the dark app it still separates from `--background`
 * (#12151C) by its border and its lift rather than by its tone. So the theme
 * prop steers only sileo's own internals, and the card reads the same either way.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  return (
    <SileoToaster
      position={POSITION}
      theme={dark ? "dark" : resolvedTheme === "light" ? "light" : "system"}
      options={{
        fill: "black",
        // ⚠️ THESE TWO CLASSES MUST STAY WRITTEN OUT AS LITERALS HERE. Tailwind
        // emits a utility only when its scanner sees the string in source, so
        // building either one (`text-white/${n}`, or a name assembled in a
        // helper) makes the class reach the DOM while styling nothing — which
        // is exactly how the earlier `styles` attempt failed.
        styles: {
          title: "text-white!",
          description: "text-white/75!",
        },
      }}
    />
  );
}

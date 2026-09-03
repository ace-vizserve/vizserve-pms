"use client";

import * as React from "react";
import { useTheme } from "next-themes";
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
 * What NO CALL SITE may pass: sileo's `styles`, `fill`, `roundness`, `icon` and
 * `autopilot`. Per-call visual overrides are how a toast system ends up with
 * fourteen looks; those decisions are made once, in `<Toaster>` below.
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
    button: options?.action
      ? { title: options.action.label, onClick: options.action.onClick }
      : undefined,
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
    options?.action
      ? emit(sileo.action, message, options)
      : emit(sileo.show, message, options),
  {
    success: (message: React.ReactNode, options?: ToastOptions) =>
      emit(sileo.success, message, options),
    error: (message: React.ReactNode, options?: ToastOptions) =>
      emit(sileo.error, message, options),
    info: (message: React.ReactNode, options?: ToastOptions) => emit(sileo.info, message, options),
    warning: (message: React.ReactNode, options?: ToastOptions) =>
      emit(sileo.warning, message, options),

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
 * ⚠️ `fill` IS AN SVG ATTRIBUTE, NOT A CSS BACKGROUND, and this cost a round.
 *
 * sileo draws the toast as a filtered SVG shape — that is what the gooey
 * morph between collapsed and expanded actually is — so `fill` reaches an SVG
 * `fill`, which takes a paint value: a colour, or `url(#id)`. It was first set
 * to `linear-gradient(...)`, which is CSS syntax an SVG cannot parse. Nothing
 * warned; the shape simply fell back to its default white, which is why the
 * rendered toast looked nothing like the mockup.
 *
 * ⚠️ SO THE LIT TOP EDGE IS NOT AVAILABLE HERE, and the earlier note claiming
 * it arrives "through fill as a gradient" was wrong. §1.5's `--hl` is an inset
 * box-shadow on a DOM box; this surface is a filtered SVG path, and neither an
 * inset shadow of ours nor a gradient fill can sit on it without a `<defs>`
 * gradient the library gives no way to inject. The toast is the one raised
 * object in the product without the highlight. Getting it back means a fork.
 *
 * These are the top stop of `--gradient-raised`, flattened — restated here
 * because `fill` is a value prop and cannot read a token.
 */
const SURFACE_LIGHT = "#ffffff";
const SURFACE_DARK = "#1d222c";

/**
 * `--radius-xl`. A toast is an overlay, so it takes the overlay radius rather
 * than sileo's stock capsule — the collapsed pill was the one shape in the
 * product that belonged to no other component.
 */
const ROUNDNESS = 14;

/**
 * The text parts, as classNames.
 *
 * ⚠️ EVERY ONE CARRIES `!`, AND WITHOUT IT NONE OF THEM APPLIED. sileo's own
 * rules are single attribute selectors — `[data-sileo-title]`, (0,1,0) — which
 * TIES with a Tailwind utility, and ties go to source order. sileo injects its
 * stylesheet from JavaScript at mount, so it always lands after ours and always
 * won. The trailing `!` is Tailwind v4's important modifier, the same escape
 * `components/ui/command.tsx` already uses on `h-8!` for the same reason.
 *
 * What each one is actually correcting:
 *
 *   title        13.2px / 500, `text-transform: capitalize`, coloured by the
 *                STATE. Three problems: our scale says 14/600, we do not
 *                Capitalise Every Word Of A Sentence, and Direction B puts the
 *                state in the badge alone so the title stays `--foreground`.
 *   description  14px and a 1rem pad; ours is 13px, tighter, and muted.
 *   button       a 9999px pill; ours is `--radius-md`.
 *   badge        24px; ours is the 20px icon-tile size, with the state's
 *                hairline so it reads as a chip rather than a dot.
 */
const STYLES = {
  title: "text-sm! leading-snug! font-semibold! text-foreground! normal-case!",
  description: "px-0! pt-1! pb-0! text-[13px]! leading-relaxed! text-muted-foreground!",
  button: "h-7! rounded-md! px-2.5! text-xs! font-semibold!",
  badge: "size-5! border! border-(--sileo-tone-border)!",
} as const;

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
 * The FILL has no such fallback available — it is one value, not a media query
 * — so it follows `resolvedTheme` directly and is simply light until the theme
 * resolves. A toast cannot fire that early.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  return (
    <SileoToaster
      position={POSITION}
      theme={dark ? "dark" : resolvedTheme === "light" ? "light" : "system"}
      options={{
        fill: dark ? SURFACE_DARK : SURFACE_LIGHT,
        roundness: ROUNDNESS,
        styles: { ...STYLES },
      }}
    />
  );
}

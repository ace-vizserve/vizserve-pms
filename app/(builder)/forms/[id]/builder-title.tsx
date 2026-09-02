"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { renameForm } from "@/app/(app)/forms/actions";

import { useSaveStatus } from "./save-status";

/**
 * P7-66 — THE FORM'S NAME, EDITED WHERE IT IS DISPLAYED.
 *
 * It used to be a text input on a settings card two scrolls down, under a
 * disclosure that was collapsed by default. So the one thing on the screen that
 * says which form you are looking at was also the one thing you could not
 * change without going to look for it.
 *
 * ⚠️ IT IS AN `<input>` THAT LOOKS LIKE A HEADING, NOT A HEADING THAT BECOMES
 * AN INPUT ON CLICK. The click-to-edit pattern needs a second affordance to
 * announce itself, loses the caret position on the transition, and is invisible
 * to anybody arriving by keyboard — Tab lands on a heading that does nothing.
 * A real input is focusable, announces itself as a textbox with a name, and
 * takes a caret exactly where the pointer went down. What is styled away is only
 * the border, and it comes back on hover and focus.
 *
 * ⚠️ THE `<h1>` IS STILL HERE, WRAPPED AROUND IT. This route left the app shell
 * and its breadcrumb, so this is the page's only heading — and a document whose
 * first heading is an `<input>` has no heading at all to a screen reader jumping
 * by landmark.
 *
 * ⚠️ SAVED ON A PAUSE, NOT ON EVERY KEYSTROKE. A rename is one `UPDATE` on one
 * column, but a keystroke-per-write turns "Website Change Request" into
 * twenty-three round trips and twenty-three `revalidatePath` calls, each one
 * re-rendering the page under the person still typing into it.
 */

/** Long enough to be a pause in typing, short enough not to feel like a delay. */
const RENAME_DEBOUNCE_MS = 700;

export function BuilderTitle({ formId, name }: { formId: string; name: string }) {
  const router = useRouter();
  const { track } = useSaveStatus();

  const [value, setValue] = useState(name);

  /*
   * ⚠️ WHAT THE SERVER LAST CONFIRMED, so a save is only sent when the name has
   * actually changed. Without it, a blur after a no-op edit — click in, click
   * out — writes the same string back and blinks "Saving…" at somebody who
   * changed nothing.
   */
  const savedRef = useRef(name);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * ⚠️ ESCAPE HAS TO TELL `onBlur` NOT TO SAVE, AND A `setValue` CANNOT.
   *
   * `blur()` dispatches SYNCHRONOUSLY, so the handler below runs before React
   * has processed the state update Escape just queued — it reads the pre-Escape
   * `value` out of its closure and commits the very edit Escape abandoned. The
   * repaint then puts the old name back on screen over a database now holding
   * the discarded one, which is the worst of both: the change was saved AND the
   * screen says it was not.
   *
   * A ref is read at the moment `onBlur` runs rather than at the moment the
   * render closed over it, which is exactly the difference that matters.
   */
  const abandonRef = useRef(false);

  /*
   * ⚠️ THE NAME CAN CHANGE SOMEWHERE ELSE, AND THIS HEADING HAS TO FOLLOW.
   *
   * The Settings tab has a Name field too, and the builder keeps all three tabs
   * MOUNTED so the question canvas survives a tab change — so a rename saved
   * there leaves this input holding the name the page loaded with, and the next
   * edit up here writes the stale one back over it. That is the mirror image of
   * the effect on `FormSettings`, and it has to exist on both sides or one of
   * the two always loses.
   *
   * ⚠️ IT DOES NOT FIGHT SOMEBODY TYPING HERE. The dependency is the SERVER's
   * name, which does not change while this input is being edited — it changes
   * only when a save lands and the page revalidates. `savedRef` is what makes
   * that true: it is updated by this component's own saves, so the effect sees
   * the prop catch up to a value it already knows about and does nothing.
   */
  useEffect(() => {
    if (name === savedRef.current) return;

    savedRef.current = name;
    setValue(name);
  }, [name]);

  // A timer that fires after this component has gone writes into an unmounted
  // tree; one that is merely pending when the tab changes must still fire,
  // which is why this clears on unmount only.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  function save(next: string) {
    const trimmed = next.trim();

    /*
     * ⚠️ AN EMPTY BOX IS NOT A RENAME, AND IT IS NOT AN ERROR EITHER. Somebody
     * clearing the field to retype it passes through "" on the way, and every
     * intermediate state here is a real save. `renameForm` would refuse it —
     * correctly — and the top bar would flash a failure at somebody who is
     * mid-word. So a blank is simply not sent, and the name on the server stays
     * whatever it was until a real one is typed. `revert` on blur is what
     * stops the box being left visibly empty over a form that still has a name.
     */
    if (trimmed === "" || trimmed === savedRef.current) return;

    /*
     * ⚠️ `.catch`, BECAUSE `track` RE-THROWS BY DESIGN. It settles the indicator
     * on a rejection and then rethrows so a caller's own handling still runs —
     * and this caller's handling is precisely "the indicator already said so".
     * Without the catch that rethrow is an unhandled promise rejection on every
     * dropped connection, which in a browser is a console error and in some
     * hosts a hard page error.
     *
     * The reason is logged rather than shown: the top bar is already saying
     * "Not saved" with the sentence, and a stack helps nobody reading it.
     */
    void track(async () => {
      const result = await renameForm(formId, trimmed);

      if (!result.ok) {
        return { outcome: { kind: "failed" as const, message: result.error }, value: undefined };
      }

      savedRef.current = trimmed;
      // The name appears in the browser tab's title, in the preview pane's
      // header and on the Settings card. All three are server-rendered.
      router.refresh();
      return { outcome: { kind: "saved" as const }, value: undefined };
    }).catch((cause: unknown) => {
      console.error("[P7-66] renaming the form threw —", cause);
    });
  }

  function onChange(next: string) {
    setValue(next);

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(next), RENAME_DEBOUNCE_MS);
  }

  function onBlur() {
    // Leaving the field commits immediately rather than waiting out the rest of
    // the debounce — a person who has clicked away has finished.
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    // Escape got here first. See `abandonRef`: this is the only place that can
    // tell an abandoned edit from a finished one, because both arrive as a blur.
    if (abandonRef.current) {
      abandonRef.current = false;
      setValue(savedRef.current);
      return;
    }

    if (value.trim() === "") {
      // Put the real name back rather than leaving a blank box over a form that
      // is still called something. See `save`.
      setValue(savedRef.current);
      return;
    }

    save(value);
  }

  return (
    <h1 className="min-w-0">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          // Enter commits and gets out of the way; Escape abandons the edit.
          // Both are what a person expects of an in-place field, and neither is
          // available from an input that only saves on blur.
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            // The flag BEFORE the blur, and the debounce cancelled with it —
            // otherwise a timer set two keystrokes ago still fires and saves the
            // abandoned name a moment later, with nothing on screen to explain
            // where it came from.
            abandonRef.current = true;
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            setValue(savedRef.current);
            event.currentTarget.blur();
          }
        }}
        aria-label="Form name"
        // `-ml-1.5` pulls the padded box back so the text sits on the same
        // optical left edge as everything else in the bar — an in-place field
        // that shifts its own label by 6px announces itself as an input before
        // anybody hovers it.
        className="-ml-1.5 w-[26ch] max-w-[38vw] truncate rounded-md bg-transparent px-1.5 py-0.5 text-sm font-semibold tracking-tight hover:bg-accent focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-primary"
      />
    </h1>
  );
}

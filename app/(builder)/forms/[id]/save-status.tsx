"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";

/**
 * P7-66 — WHERE "ALL CHANGES SAVED" COMES FROM.
 *
 * The builder autosaves. There is no Save button, no Cancel, and no dirty-locked
 * list — which removes the thing that used to tell somebody their work was
 * safe. A screen that writes silently and says nothing is worse than one with a
 * button: the person cannot tell a save that landed from one that never ran.
 *
 * So the status is its own small piece of shared state, and it is SHARED
 * deliberately. Two independent things autosave into the same form — the title
 * in the top bar and the question canvas — and two indicators disagreeing about
 * whether the form is saved is exactly the confusion this is meant to remove.
 * One line, one truth, in the one place the eye already goes for it.
 *
 * ⚠️ IN-FLIGHT SAVES ARE COUNTED, NOT FLAGGED. A boolean goes wrong the moment
 * two overlap: rename the form while a question save is still running, and the
 * first to return clears the indicator while the second is still writing —
 * "All changes saved" over a save in progress. A counter cannot say that.
 *
 * ⚠️ A FAILURE IS STICKY, and that is the asymmetry worth having. `saving` and
 * `saved` are moments; `failed` is a state the person has to do something
 * about, so it stays on screen until the next save actually succeeds. The
 * message travels with it, because "not saved" without a reason is an alarm
 * with no action attached.
 */

type SaveOutcome =
  | { kind: "saved" }
  /** The sentence to show. Never a raw stack — the caller writes it. */
  | { kind: "failed"; message: string };

type SaveStatusApi = {
  /**
   * Reports that there are edits on screen the database does not have.
   *
   * ⚠️ WITHOUT THIS THE LINE IS A LIE, AND IT IS THE MOST DAMAGING KIND: one
   * that reassures. `track` only knows about saves that are RUNNING, so a
   * half-typed question — or, in the phase before the canvas autosaved at all,
   * a question sitting there with its own Save button — left the top bar
   * reading "All changes saved" over work that was in no database anywhere.
   *
   * Called from an effect with a derived boolean rather than toggled by hand:
   * the canvas already computes whether the document differs from the last one
   * the database accepted (`sameFormSchema`), and a second, hand-maintained
   * copy of that fact is a second thing that can be wrong.
   */
  setDirty: (dirty: boolean) => void;
  /**
   * Wraps one save.
   *
   * The indicator goes busy for as long as the promise is pending and settles
   * from what it resolves to — so a caller cannot mark a save finished and
   * forget to mark it started, which is the only way to get a permanent
   * spinner.
   *
   * ⚠️ IT DOES NOT SWALLOW A THROW. A rejected promise settles the indicator as
   * a failure and RE-THROWS, so the caller's own error handling still runs. A
   * status indicator must not become a place errors go to be quietly absorbed.
   */
  track: <T>(run: () => Promise<{ outcome: SaveOutcome; value: T }>) => Promise<T>;
};

const SaveStatusContext = createContext<SaveStatusApi | null>(null);

type Settled = { kind: "idle" } | SaveOutcome;

export function SaveStatusProvider({ children }: { children: React.ReactNode }) {
  const [inFlight, setInFlight] = useState(0);
  const [dirty, setDirtyState] = useState(false);
  const [settled, setSettled] = useState<Settled>({ kind: "idle" });

  /*
   * A ref as well as state. `track` must not change identity when the count
   * does — it is passed to effects and callbacks in the canvas, and a new
   * function on every save would re-run them mid-save. The state drives the
   * render; the ref is what the callback reads.
   */
  const countRef = useRef(0);

  const track = useCallback<SaveStatusApi["track"]>(async (run) => {
    countRef.current += 1;
    setInFlight(countRef.current);

    try {
      const { outcome, value } = await run();
      setSettled(outcome);
      return value;
    } catch (cause) {
      /*
       * A THROW IS A FAILED SAVE, and it is the one the caller is least likely
       * to have thought about: a server action can REJECT — a dropped
       * connection, a redeploy mid-request — rather than returning
       * `{ ok: false }`. Left untracked, the indicator would sit on "Saving…"
       * for the rest of the session.
       */
      setSettled({
        kind: "failed",
        message: "The connection dropped before we heard back. Your last change may not be saved.",
      });
      throw cause;
    } finally {
      countRef.current -= 1;
      setInFlight(countRef.current);
    }
  }, []);

  /*
   * Stable, like `track`, and for the same reason: this is called from an
   * effect whose dependency list contains it, and an identity that changed on
   * every render would re-run that effect on every render. `useState`'s setter
   * is already stable, so the wrapper only exists to keep the API one shape.
   */
  const setDirty = useCallback((next: boolean) => setDirtyState(next), []);

  const api = useMemo(() => ({ track, setDirty }), [track, setDirty]);

  return (
    <SaveStatusContext.Provider value={api}>
      <SaveStatusStateContext.Provider value={{ inFlight, dirty, settled }}>
        {children}
      </SaveStatusStateContext.Provider>
    </SaveStatusContext.Provider>
  );
}

const SaveStatusStateContext = createContext<{
  inFlight: number;
  dirty: boolean;
  settled: Settled;
}>({
  inFlight: 0,
  dirty: false,
  settled: { kind: "idle" },
});

/**
 * The API, for anything that saves.
 *
 * ⚠️ THROWS OUTSIDE THE PROVIDER rather than returning a no-op. A silent
 * fallback here is a canvas that saves with no indicator at all, which is the
 * exact failure this file exists to prevent — and it would only be noticed by
 * somebody losing work.
 */
export function useSaveStatus(): SaveStatusApi {
  const api = useContext(SaveStatusContext);

  if (api === null) {
    throw new Error("useSaveStatus must be used inside <SaveStatusProvider>.");
  }

  return api;
}

/**
 * The line itself.
 *
 * `role="status"` — a polite live region. Not `alert`, even on a failure: this
 * updates on every keystroke's debounce, and an assertive region announcing
 * "Saving…" over somebody typing makes the screen unusable with a reader on.
 * The failure carries `CircleAlert` and destructive colour as well as the words,
 * because state is never conveyed by colour alone (CLAUDE.md).
 */
export function SaveStatusLine() {
  const { inFlight, dirty, settled } = useContext(SaveStatusStateContext);

  if (inFlight > 0) {
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Loader2 aria-hidden className="size-3 animate-spin" />
        Saving…
      </span>
    );
  }

  if (settled.kind === "failed") {
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 text-xs text-destructive"
        // The reason, reachable without a second click. The line has to stay
        // short — it sits under the form name in a 56px bar — and the sentence
        // that says what to do about it does not fit there.
        title={settled.message}
      >
        <CircleAlert aria-hidden className="size-3" />
        Not saved
      </span>
    );
  }

  /*
   * ⚠️ CHECKED AFTER `failed` AND BEFORE `saved`. A form can be both dirty and
   * carrying a failed save — that is the ordinary state after a refusal, since
   * the edit that was refused is still on screen — and "Not saved", with its
   * reason, is the more useful of the two sentences.
   */
  if (dirty) {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        Unsaved changes
      </span>
    );
  }

  /*
   * ⚠️ `idle` AND `saved` READ THE SAME, AND THAT IS TRUE RATHER THAN LAZY. A
   * builder that has just opened is showing exactly what the database holds, so
   * "all changes saved" is a correct statement about a form nobody has touched
   * yet — and the alternative, a blank space that fills in only after the first
   * edit, tells somebody nothing on the load where they most want reassurance.
   *
   * It is only reachable with `dirty` false, which is what makes it honest: the
   * canvas reports every edit the database does not have.
   */
  return (
    <span role="status" className="text-xs text-muted-foreground">
      All changes saved
    </span>
  );
}

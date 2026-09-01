"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateTaskField } from "../actions";

/**
 * P7-55 — per-field autosave for `/tasks/[id]`.
 *
 * ⚠️ THIS IS THE FIRST TIMER-BASED AUTOSAVE IN THE REPO, and that is a
 * deliberate exception rather than an oversight. `components/list-search.tsx`
 * is the only other debounced control and its header calls a second copy of one
 * an anti-pattern — but it debounces NAVIGATION (pushing a query string), and
 * this debounces PERSISTENCE. They are different problems and they must not be
 * merged. What that warning is really about is two copies of the same thing, so
 * this hook is the single owner of debounced saving on this page: no component
 * below it holds a timer.
 *
 * THE RULE THIS HOOK ENCODES:
 *
 *   free text debounces · every discrete control writes on its own commit
 *   event · blur always flushes an outstanding timer
 *
 * A `DatePicker` click, a `Select` choice and a priority press each emit exactly
 * one event. A timer on those is pure latency plus an 800ms window in which the
 * write can be lost — so they call `commit`. Only the resolution textarea and
 * the output link call `schedule`.
 *
 * ⚠️ NOT BUILT ON `usePatch` (`app/(app)/tasks/inline.tsx:50`), and the reason
 * matters: that hook has one shared `useTransition` per instance, always toasts
 * and always `router.refresh()`es. It is correct for a list row editing one
 * field at a time, and wrong here, where six fields save independently and two
 * of them must NOT trigger a refresh. The relationship is the same one
 * `week-grid.tsx`'s state-free `persist` has to its ordinary path — a second,
 * narrower writer for a surface with different constraints. Keep them in step.
 *
 * ⚠️ ROLLBACK DIVERGES FROM THE HOUSE CONTRACT, ON PURPOSE. `inline.tsx:41-46`
 * says a refused patch must put the old value back, and for a discrete control
 * that is right and mandatory — the caller passes `onRefused` and does exactly
 * that. For a debounced textarea somebody is still typing in, restoring the old
 * value would delete their work to report a failure. So free-text callers pass
 * no `onRefused`: the refusal toasts, the field is marked unsaved, and the box
 * is left alone. Do not "fix" this into a rollback.
 */

/** How long after the last keystroke a free-text field writes itself. */
const DEBOUNCE_MS = 800;

/** How long the "Saved" mark lingers. Matches `week-grid.tsx:1280`. */
const SAVED_MS = 1600;

export type FieldState = "idle" | "saving" | "saved";

type CommitOptions = {
  /**
   * Put the old value back. REQUIRED for discrete controls, omitted for free
   * text — see the header.
   */
  onRefused?: () => void;
  /**
   * Whether a success should re-run the server component. False for fields
   * nothing else on the page renders; `updateTaskField` already revalidates
   * four paths on the server, so an extra client refresh per keystroke pause is
   * the difference between this feeling instant and feeling like a page load.
   */
  refresh?: boolean;
};

export type TaskAutosave = {
  /** Write now. For controls that emit one event per decision. */
  commit: (key: string, value: unknown, options?: CommitOptions) => void;
  /** Write `DEBOUNCE_MS` after the last call for this key. For free text. */
  schedule: (key: string, value: unknown, options?: CommitOptions) => void;
  /** Fire outstanding timers — one key on blur, or every key before a move. */
  flush: (key?: string) => Promise<void>;
  /** Drop an outstanding timer. For a draft that no longer validates. */
  cancel: (key: string) => void;
  stateOf: (key: string) => FieldState;
  /** Anything in flight or waiting on a timer. */
  busy: boolean;
  /** Something landed within the last `SAVED_MS`. */
  justSaved: boolean;
};

export function useTaskAutosave(taskId: string): TaskAutosave {
  const router = useRouter();

  const [states, setStates] = useState<Record<string, FieldState>>({});

  /**
   * Timers and the values they are holding, keyed by column.
   *
   * Refs rather than state because the flush path below runs during an effect
   * cleanup, when there is nothing left to render into — the same constraint
   * `week-grid.tsx:1239-1240` records about its own `persist`.
   */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const drafts = useRef(new Map<string, { value: unknown; options: CommitOptions }>());

  const setState = useCallback((key: string, state: FieldState) => {
    setStates((current) => ({ ...current, [key]: state }));
  }, []);

  /**
   * The write itself. Deliberately NOT wrapped in `useTransition`.
   *
   * A transition would tie every field to one shared `pending`, which is the
   * exact behaviour this page is losing: disabling a focused textarea mid-save
   * blurs it and drops the caret to position 0.
   */
  const write = useCallback(
    async (key: string, value: unknown, options: CommitOptions) => {
      setState(key, "saving");

      const result = await updateTaskField(taskId, { [key]: value });

      if (!result.ok) {
        // A policy-refused UPDATE is success with zero rows (trap 9), and
        // `updateTaskField` is what turns that into this sentence. Loud, always
        // — a silent failed autosave is worse than no autosave.
        options.onRefused?.();
        toast.error(result.error);
        setState(key, "idle");
        return;
      }

      setState(key, "saved");
      if (options.refresh !== false) router.refresh();
    },
    [router, setState, taskId],
  );

  const clearTimer = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    drafts.current.delete(key);
  }, []);

  const commit = useCallback(
    (key: string, value: unknown, options: CommitOptions = {}) => {
      clearTimer(key);
      void write(key, value, options);
    },
    [clearTimer, write],
  );

  const schedule = useCallback(
    (key: string, value: unknown, options: CommitOptions = {}) => {
      clearTimer(key);
      drafts.current.set(key, { value, options });

      // "saving" from the moment a timer is set, not from the moment the request
      // leaves. The window is what the person is waiting through, and calling it
      // idle for 800ms is how "did that save?" happens.
      setState(key, "saving");

      timers.current.set(
        key,
        setTimeout(() => {
          const draft = drafts.current.get(key);
          timers.current.delete(key);
          drafts.current.delete(key);
          if (draft) void write(key, draft.value, draft.options);
        }, DEBOUNCE_MS),
      );
    },
    [clearTimer, setState, write],
  );

  const cancel = useCallback(
    (key: string) => {
      clearTimer(key);
      setState(key, "idle");
    },
    [clearTimer, setState],
  );

  const flush = useCallback(
    async (key?: string) => {
      const keys = key ? [key] : [...drafts.current.keys()];

      await Promise.all(
        keys.map((each) => {
          const draft = drafts.current.get(each);
          if (!draft) return Promise.resolve();
          clearTimer(each);
          return write(each, draft.value, draft.options);
        }),
      );
    },
    [clearTimer, write],
  );

  /**
   * Do not lose a draft to a tab switch or a navigation.
   *
   * Copied from `week-grid.tsx:1246-1275`, including what it refuses to do:
   * `visibilitychange` covers the phone and the closed tab, the cleanup covers
   * navigation and unmount, and NEITHER is `beforeunload` — unreliable on mobile
   * Safari, cannot await, and it is the hook that produces "leave site?", which
   * would be a prompt on the way out of a page whose whole point is that saving
   * is invisible.
   *
   * The flush here reads only refs and calls the action directly. It sets no
   * state, because by the time the cleanup runs there is nothing to render into.
   * A write that lands after the page has gone still revalidates a route nobody
   * is looking at, which is harmless and is what `week-grid` already does.
   */
  useEffect(() => {
    const pending = drafts.current;
    const running = timers.current;

    function flushNow() {
      for (const [key, draft] of pending.entries()) {
        const timer = running.get(key);
        if (timer) clearTimeout(timer);
        running.delete(key);
        void updateTaskField(taskId, { [key]: draft.value });
      }
      pending.clear();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") flushNow();
    }

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      flushNow();
    };
  }, [taskId]);

  /** Every "saved" mark fades after a beat. One timer for the whole card. */
  const anySaved = Object.values(states).some((state) => state === "saved");

  useEffect(() => {
    if (!anySaved) return;
    const timer = setTimeout(() => {
      setStates((current) => {
        const next: Record<string, FieldState> = {};
        for (const [key, state] of Object.entries(current)) {
          next[key] = state === "saved" ? "idle" : state;
        }
        return next;
      });
    }, SAVED_MS);
    return () => clearTimeout(timer);
  }, [anySaved]);

  const stateOf = useCallback((key: string) => states[key] ?? "idle", [states]);

  return {
    commit,
    schedule,
    flush,
    cancel,
    stateOf,
    busy: Object.values(states).some((state) => state === "saving"),
    justSaved: anySaved,
  };
}

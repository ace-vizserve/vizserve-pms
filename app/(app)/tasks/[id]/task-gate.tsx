"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { isRichTextEmpty } from "@/lib/rich-text";

/**
 * P7-57 — THE RESOLUTION GATE, SHARED BY TWO COMPONENTS.
 *
 * The revamp moves the promoted move ("Send for QA") out of the properties and
 * into the page header, beside the title, where the mockup puts the one action
 * a task is waiting on. The resolution textarea it depends on stays where the
 * work is, three sections down the surface. That is the whole reason this
 * exists.
 *
 * ⚠️ THE GATE READS THE SAVED VALUE, NEVER THE DRAFT. `vizserve_pms_transition_task`
 * checks the stored column, so a button enabled because somebody has typed into
 * the box is a button that offers a move the server then refuses. The surface
 * pushes here on every accepted write; the header reads `resolutionMissing`.
 *
 * ⚠️ AND IT CARRIES THE FLUSH. A mouse click blurs the textarea and commits it,
 * but the keyboard path does not — so without `flush()` the worst failure on
 * this page comes back: a resolution typed, and the move refused because the
 * column is still empty, with the text plainly on screen. The surface registers
 * its autosave flush; the header awaits it before every transition.
 *
 * Context rather than lifting the state into a wrapper component: `page.tsx` is
 * a server component and the header, the surface and the request panel are
 * three separate trees under it. A wrapper would have to become a client
 * component holding all of them as slots, which is the arrangement P7-56 spent
 * a whole refactor getting away from.
 */

type Flush = () => Promise<void>;

type TaskGate = {
  /** The SAVED resolution is empty, so a `requires: "resolution"` move is refused. */
  resolutionMissing: boolean;
  /** The surface, after a write the server accepted. */
  setSavedResolution: (value: string) => void;
  /** The surface, once — hands over its autosave flush. */
  registerFlush: (flush: Flush | null) => void;
  /** The header, before every move. A no-op until the surface has registered. */
  flush: Flush;
};

const TaskGateContext = createContext<TaskGate | null>(null);

export function TaskGateProvider({
  resolution,
  children,
}: {
  /** As the database last returned it. */
  resolution: string;
  children: React.ReactNode;
}) {
  const [saved, setSaved] = useState(resolution);
  const flushRef = useRef<Flush | null>(null);

  const registerFlush = useCallback((flush: Flush | null) => {
    flushRef.current = flush;
  }, []);

  const flush = useCallback(async () => {
    await flushRef.current?.();
  }, []);

  const value = useMemo<TaskGate>(
    () => ({
      resolutionMissing: isRichTextEmpty(saved),
      setSavedResolution: setSaved,
      registerFlush,
      flush,
    }),
    [saved, registerFlush, flush],
  );

  return <TaskGateContext.Provider value={value}>{children}</TaskGateContext.Provider>;
}

export function useTaskGate(): TaskGate {
  const gate = useContext(TaskGateContext);
  if (!gate) throw new Error("useTaskGate must be used inside <TaskGateProvider>.");
  return gate;
}

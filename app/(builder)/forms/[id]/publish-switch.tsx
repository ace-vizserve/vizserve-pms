"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { setFormPublished } from "@/app/(app)/forms/actions";

import { useSaveStatus } from "./save-status";

/**
 * P7-66 — DRAFT ⇄ PUBLISHED, IN THE HEADER.
 *
 * ⚠️ THIS REPLACED A CHIP THAT ONLY REPORTED. The header carried a `Live` /
 * `Draft` pill and the only way to change it was the Settings tab, three clicks
 * away, in a card of eleven other controls — for the one decision that is made
 * over and over while a form is being built: show it to people, take it back
 * down, show it again. The state was already in the header; only the verb was
 * missing.
 *
 * ⚠️ IT IS STILL A LABELLED STATE, NOT A COLOURED TOGGLE. CLAUDE.md: state is
 * never conveyed by colour alone. The word beside the switch says which of the
 * two it is, so the control reads the same to somebody who cannot tell the track
 * colours apart — and the word is the one the rest of the app uses, `Draft` or
 * `Published`, not `On`/`Off`.
 *
 * ⚠️ THE SETTINGS CARD STILL HAS ITS OWN SWITCH, AND THE TWO MUST NOT DRIFT.
 * The builder keeps every tab MOUNTED, so a change here has to reach a card that
 * is sitting off-screen holding the old value, and vice versa. `router.refresh()`
 * re-renders the server components — which is what the Settings card's own
 * `initial` comes from — and the effect below re-syncs this switch when the prop
 * catches up. Same shape as `BuilderTitle`, for the same reason: two controls
 * over one column, and whichever moves last must win in both places.
 */
export function PublishSwitch({
  formId,
  isActive,
  /**
   * ⚠️ WHERE THE FORM'S FACE IS, WHICH IS NOT THE SAME SENTENCE ON BOTH KINDS.
   * A published client form is on the public internet with no session; a
   * published internal form needs one. Calling both "live" tells somebody the
   * wrong thing about exactly the state they just changed.
   */
  isInternal,
}: {
  formId: string;
  isActive: boolean;
  isInternal: boolean;
}) {
  const router = useRouter();
  const { track } = useSaveStatus();

  const [checked, setChecked] = useState(isActive);
  const [error, setError] = useState<string | null>(null);

  /**
   * The value the server last confirmed.
   *
   * Read by the effect below so a refresh caused by THIS component's own save
   * does not look like a change made somewhere else and re-set the switch under
   * the pointer.
   */
  const savedRef = useRef(isActive);

  useEffect(() => {
    if (isActive === savedRef.current) return;

    savedRef.current = isActive;
    setChecked(isActive);
  }, [isActive]);

  function toggle(next: boolean) {
    /*
     * OPTIMISTIC, AND PUT BACK ON A REFUSAL. Publishing is a round trip through
     * a check constraint, and a switch that does not move until the server
     * answers reads as broken. The revert is the honest half of that: a form
     * with no routing department cannot be published, and the switch must not
     * be left claiming it was.
     */
    setChecked(next);
    setError(null);

    // `.catch` because `track` re-throws by design — see the note in
    // `BuilderTitle`. The indicator has already reported it.
    void track(async () => {
      const result = await setFormPublished(formId, next);

      if (!result.ok) {
        setChecked(!next);
        setError(result.error);
        return { outcome: { kind: "failed" as const, message: result.error }, value: undefined };
      }

      savedRef.current = next;
      // The Settings card, the "View public form" link and the /forms list all
      // read this column, and all three are server-rendered.
      router.refresh();
      return { outcome: { kind: "saved" as const }, value: undefined };
    }).catch((cause: unknown) => {
      console.error("[P7-66] publishing the form threw —", cause);
    });
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Switch
        id="form-published"
        checked={checked}
        onCheckedChange={toggle}
        aria-describedby={error === null ? undefined : "form-published-error"}
      />
      <label
        htmlFor="form-published"
        className={cn(
          "cursor-pointer text-xs font-medium",
          checked ? "text-success" : "text-muted-foreground",
        )}
      >
        {checked ? "Published" : "Draft"}
      </label>

      {/*
        ⚠️ THE REFUSAL IS SHOWN HERE, NOT ONLY IN THE SAVE INDICATOR. The
        indicator says "Not saved" under the form's name, which on a header
        somebody has just clicked in is easy to miss — and the one refusal this
        control produces is fixable, on another tab, and worth naming.
      */}
      {error === null ? null : (
        <p
          id="form-published-error"
          role="alert"
          className="max-w-64 text-xs leading-tight text-destructive"
        >
          {error}
        </p>
      )}

      {/* What "published" actually means for THIS kind of form, for anybody who
          has not met both. Hidden once it would only repeat the label. */}
      <span className="sr-only">
        {checked
          ? isInternal
            ? "Colleagues who are signed in can open and answer this form."
            : "Anyone with the URL can submit this form, with no login."
          : "The form's URL returns not found."}
      </span>
    </div>
  );
}

"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";

/**
 * Light / System / Dark, as three visible choices rather than a flip.
 *
 * THE OLD BUTTON COULD NOT GET BACK TO "SYSTEM". It read `resolvedTheme` and
 * wrote the opposite, so the first click stored an explicit preference and
 * nothing in the app ever cleared it — a person who wanted their OS to decide
 * had no way to say so once they had touched it. Three segments make the
 * setting reachable in both directions, which is the actual fix here; the shape
 * is the smaller half of it.
 *
 * `theme` rather than `resolvedTheme`, because "system" is now a selectable
 * value and `resolvedTheme` can only ever answer light or dark.
 */
const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

/*
 * "Has this hydrated yet?" as an external store rather than setState-in-effect.
 * Subscribing to nothing is correct: the answer changes exactly once, at
 * hydration, and React reads the client snapshot from that point on.
 */
const noop = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = React.useSyncExternalStore(noop, clientSnapshot, serverSnapshot);

  /*
   * NOTHING IS SELECTED UNTIL MOUNTED. The server cannot know the stored theme,
   * so committing to a segment during SSR guarantees a hydration mismatch.
   *
   * The icons render either way, so the track keeps its size and its contents
   * and only the thumb arrives late. The empty string is the "nothing selected"
   * value — no option carries it, so no segment is checked. The previous
   * version blanked the whole control instead, which was right for a single
   * button and would be an empty box here.
   */
  const value = mounted ? (theme ?? "system") : "";

  return (
    <Segmented
      value={value}
      onValueChange={(next) => setTheme(next as string)}
      aria-label="Theme"
    >
      {OPTIONS.map(({ value: option, label, icon: Icon }) => (
        <SegmentedItem key={option} value={option} className="size-7" aria-label={label}>
          <Icon className="size-4" aria-hidden />
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

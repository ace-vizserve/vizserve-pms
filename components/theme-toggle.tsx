"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Light/dark toggle.
 *
 * `resolvedTheme` rather than `theme`, so a "system" preference toggles away
 * from what the person is actually looking at instead of from the string
 * "system".
 *
 * Renders a blank button until mounted: the server has no way to know the
 * stored theme, so committing to an icon during SSR guarantees a hydration
 * mismatch. The button keeps its size so nothing shifts when the icon lands.
 */
// "Has this hydrated yet?" as an external store rather than setState-in-effect.
// Subscribing to nothing is correct: the answer changes exactly once, at
// hydration, and React reads the client snapshot from that point on.
const noop = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = React.useSyncExternalStore(noop, clientSnapshot, serverSnapshot);

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={mounted ? `Switch to ${isDark ? "light" : "dark"} theme` : "Switch theme"}
    >
      {mounted ? isDark ? <Sun /> : <Moon /> : null}
    </Button>
  );
}

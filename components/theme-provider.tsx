"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Dark mode was fully written in globals.css from the beginning but was never
 * reachable — nothing ever added the `.dark` class. This is what finally
 * mounts it.
 *
 * `attribute="class"` because our theme is a `.dark` selector, not a data
 * attribute. `disableTransitionOnChange` stops every colour token animating at
 * once when the theme flips, which reads as a flash rather than a transition.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

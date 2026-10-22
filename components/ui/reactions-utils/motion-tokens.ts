/**
 * Motion tokens for `components/ui/reactions.tsx`.
 *
 * The component arrived importing this file without shipping it, so these are
 * reconstructed from the curves its source design system publishes
 * (`--ease-enter`, `--ease-standard`, `--duration-*`). Seconds, because Motion
 * takes seconds. Nothing else in the app reads them.
 */
export const motionTokens = {
  ease: {
    enter: [0.16, 1, 0.3, 1],
    standard: [0.22, 1, 0.36, 1],
  },
  duration: {
    instant: 0.12,
    fast: 0.16,
    standard: 0.24,
  },
  blur: {
    subtle: 2,
    soft: 4,
  },
  spring: {
    snappy: { type: "spring", stiffness: 520, damping: 32, mass: 0.8 },
    morph: { type: "spring", stiffness: 380, damping: 34 },
    smooth: { type: "spring", stiffness: 260, damping: 32 },
  },
  stagger: {
    item: 0.025,
  },
} as const;

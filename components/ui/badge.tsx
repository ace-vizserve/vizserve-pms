import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * A badge is a RAISED object, like every other small solid thing in this system:
 * a hairline border, the `grade-chip` wash for a lit top edge, and a shadow
 * beneath. It arrived from the shadcn registry flat — `border-transparent`, a
 * single opaque fill, no lift — which is the one thing this system does not do.
 *
 * ⚠️ `grade-chip` LAYERS OVER `bg-*`, NEVER INSTEAD OF IT. The grade utilities
 * are deliberately outside the `bg-` namespace: `cn()` is tailwind-merge, which
 * treats every `bg-…` class as one conflicting property and keeps only the last,
 * so a grade named `bg-chip` would silently eat the colour token beside it.
 * Written as `bg-secondary grade-chip`, both survive. Do not rename them.
 *
 * `ghost` and `link` STAY FLAT, and that is the same deliberate exception
 * `button.tsx` makes: neither is an object, so neither gets a lift. A grade on a
 * ghost badge would give it a face it is not supposed to have.
 *
 * Shape and scale come from the shipped `Pill` in `components/status-badge.tsx`
 * — `h-7`, `rounded-md`, `text-2xs font-semibold` — because two badge systems on
 * one screen at two different heights is exactly the drift this repo has already
 * had once. The registry default was `h-5 rounded-4xl`, off both the control
 * scale and the radius scale.
 *
 * ⚠️ A DATABASE STATUS DOES NOT COME HERE. `status-badge.tsx` owns every
 * status→tone map; this is the generic primitive for a label with no enum
 * behind it. A hand-rolled status colour at a call site is an anti-pattern.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-7 w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-transparent bg-clip-padding px-2.5 text-2xs font-semibold whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        /*
         * The `[a]:hover:` compound is kept here, where `button.tsx`
         * deliberately dropped it.
         *
         * The reasoning inverts between the two: a button is interactive
         * whether or not it is an anchor, so scoping its hover to `:is(a)` cost
         * it a caller override and bought nothing. A badge is the opposite — a
         * static badge is a LABEL, and a label that lights up under the cursor
         * is promising a click that does not exist. Only the anchor form
         * responds.
         */
        default:
          "border-primary/70 bg-primary grade-primary text-primary-foreground shadow-raised [a]:hover:bg-primary/90 [a]:active:shadow-none",
        secondary:
          "border-input border-b-border-strong bg-secondary grade-chip text-secondary-foreground shadow-raised [a]:hover:bg-secondary/80 [a]:active:shadow-none",
        destructive:
          "border-destructive-border bg-destructive-subtle grade-chip text-destructive shadow-raised focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/10 [a]:active:shadow-none",
        outline:
          "border-input border-b-border-strong bg-card grade-chip text-foreground shadow-raised [a]:hover:bg-muted [a]:active:shadow-none",
        /*
         * The brand tint, as a badge. `--accent` / `--accent-foreground` /
         * `--accent-border` are a first-class trio in the system and had no
         * primitive exposing them, so every call site that wanted a
         * brand-tinted label hand-rolled one — `/admin/users` had a flat
         * `rounded-full bg-accent` span in its Leads column for exactly this
         * reason. A tint, not a state: use `Chip` from `status-badge.tsx` when
         * the thing being labelled is a status.
         */
        accent:
          "border-accent-border bg-accent grade-chip text-accent-foreground shadow-raised [a]:hover:bg-accent/70 [a]:active:shadow-none",
        // Flat on purpose — see the header. A ghost badge is not an object.
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }

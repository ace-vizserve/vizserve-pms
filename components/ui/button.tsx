import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A button is a RAISED object: a lit top edge (`shadow-raised` carries `--hl`),
 * a graded face, a darker bottom border, and a shadow beneath. Pressing it
 * collapses the lift — the button stops floating. It never inverts into an
 * inset: nothing in this system is embossed inward.
 *
 * The two exceptions are deliberate and are the only flat controls in the
 * system: `ghost` and `link` are not objects, and `disabled` drops the gradient
 * and the shadow entirely — losing the lift IS the affordance, so a disabled
 * button cannot be mistaken for a live one at a glance.
 *
 * Heights are the refresh's control scale (40 / 36 / 44 / 28), not Tailwind's, which
 * is why they are arbitrary values. They are defined once, here.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-[550] whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:bg-none disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Plain `hover:`, not badge.tsx's `[a]:hover:` — an `:is(a)` compound
        // outranks a caller's `hover:bg-*` in `className`, so a button rendered
        // as a link silently repainted itself `--primary` on hover no matter
        // what was passed in. A button is interactive whether or not it is an
        // anchor, so the anchor scope bought nothing and cost the override.
        default:
          "bg-primary grade-primary text-primary-foreground border-primary/70 shadow-raised hover:bg-primary/90 active:shadow-none",
        outline:
          "border-input border-b-border-strong bg-card grade-raised text-foreground shadow-raised hover:bg-muted hover:text-foreground active:shadow-none aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "border-input border-b-border-strong bg-secondary grade-raised text-secondary-foreground shadow-raised hover:bg-secondary/80 active:shadow-none aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        // Flat on purpose — a ghost control is not a raised object.
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "border-destructive-border bg-destructive-subtle grade-raised text-destructive shadow-raised hover:bg-destructive/10 active:shadow-none focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 gap-2 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-7 gap-1 rounded-sm px-2.5 text-2xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 rounded-md px-3 text-sm in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-10",
        "icon-xs":
          "size-7 rounded-sm in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9 rounded-md in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * `loading` is our addition to the upstream component, kept because real forms
 * depend on it. A spinner callers have to remember to wire is a spinner that
 * goes missing on the slow path — which is the only path where it matters.
 * It also sets `aria-busy` and disables the button, so the visual and the
 * assistive-tech signal cannot drift apart.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  children,
  render,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      render={render}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {/* Composition via `render` passes a single child through untouched —
          injecting a spinner there would break the slot. */}
      {render ? (
        children
      ) : (
        <>
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {children}
        </>
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }

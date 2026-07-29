import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Input — DESIGN.md component rules.
 *
 * States: default, hover, focus-visible, disabled, error. The error state is
 * driven by `aria-invalid`, so the visual and the assistive-tech signal cannot
 * drift apart — styling an error without announcing it is the failure mode this
 * avoids.
 *
 * radius.sm (10px), font.size.md (14px). 16px on small screens so iOS does not
 * zoom the viewport on focus.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-sm border border-input bg-transparent px-3 py-1 text-base shadow-ring transition-[color,box-shadow,border-color] outline-none md:text-sm",
        "selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "hover:border-ring/40",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }

"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Flame } from "lucide-react"

import { cn } from "@/lib/utils"

// Types (inlined - only fields used by this component)
interface StreakResponse {
  length: number
  frequency: "daily" | "weekly" | "monthly"
}

// Variants
const streakBadgeVariants = cva(
  "inline-flex flex-col items-center justify-center rounded-3xl border border-border/60 bg-card text-center text-card-foreground transition-colors",
  {
    variants: {
      size: {
        // One line — icon, value, subtitle — for a card with no room to spare.
        inline: "w-auto flex-row gap-1.5 rounded-full px-3 py-1",
        sm: "w-28 gap-1.5 p-3",
        default: "w-40 gap-2.5 p-5",
        lg: "w-52 gap-3 p-6",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

// Props
interface StreakBadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof streakBadgeVariants> {
  /** Streak length value */
  length?: number
  /** Streak frequency used for label rendering */
  frequency?: StreakResponse["frequency"]
  /** Optional subtitle shown below streak length */
  subtitle?: string
  /** Custom icon to replace flame */
  icon?: React.ReactNode
}

const StreakBadge = React.forwardRef<HTMLDivElement, StreakBadgeProps>(
  (
    { className, size, length, frequency = "daily", subtitle, icon, ...props },
    ref
  ) => {
    const streakLength = length ?? 0

    const frequencyLabel = {
      daily: "day",
      weekly: "week",
      monthly: "month",
    }[frequency]

    const pluralLabel =
      streakLength === 1 ? frequencyLabel : `${frequencyLabel}s`

    const iconSize = {
      inline: "h-4 w-4",
      sm: "h-10 w-10",
      default: "h-16 w-16",
      lg: "h-20 w-20",
    }[size ?? "default"]

    const valueSize = {
      inline: "text-sm",
      sm: "text-2xl",
      default: "text-5xl",
      lg: "text-6xl",
    }[size ?? "default"]

    const subtitleSize = {
      inline: "text-xs",
      sm: "text-xs",
      default: "text-sm",
      lg: "text-base",
    }[size ?? "default"]

    const subtitleText = subtitle ?? "streak"
    const valueUnit = pluralLabel

    // Build accessible label
    const ariaLabel = `${streakLength} ${pluralLabel} streak`

    return (
      <div
        ref={ref}
        role="status"
        aria-label={ariaLabel}
        className={cn(streakBadgeVariants({ size }), className)}
        {...props}
      >
        {icon ?? (
          <Flame
            className={cn(iconSize, "text-primary shrink-0")}
            aria-hidden="true"
          />
        )}
        <span
          className={cn("font-semibold tracking-tight", valueSize)}
          aria-hidden="true"
        >
          {streakLength}
          <span className={cn("text-muted-foreground font-medium", size === "inline" ? "ml-1" : "ml-2")}>
            {valueUnit}
          </span>
        </span>
        <span
          className={cn("text-muted-foreground font-normal", subtitleSize)}
          aria-hidden="true"
        >
          {subtitleText}
        </span>
      </div>
    )
  }
)
StreakBadge.displayName = "StreakBadge"

export { StreakBadge, streakBadgeVariants }
export type { StreakBadgeProps, StreakResponse }

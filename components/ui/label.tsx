"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Label.
 *
 * The upstream template has no `label.tsx` — its auth forms use bare `<label>`
 * elements. Base UI has no standalone Label primitive either; it exposes
 * `Field.Label`, which only works inside a `Field.Root`. Since 18 of our files
 * use `<Label htmlFor=…>` outside any Field, this is a plain styled `<label>`
 * with the template's typography.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }

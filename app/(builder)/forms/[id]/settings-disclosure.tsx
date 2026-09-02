"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * P7-66 Phase 4a — the form's settings, folded away under the questions.
 *
 * The questions are the work on this screen. The slug, the owning department,
 * the SLA and the routing are set once when the form is created and then left
 * alone, and a six-row card of them sitting open under the canvas made the form
 * itself look like the smaller half of the page.
 *
 * ⚠️ `keepMounted`, AND IT IS NOT AN OPTIMISATION. `FormSettings` is a
 * `react-hook-form` with its own dirty state; Base UI's panel unmounts its
 * children by default, so collapsing the section mid-edit would silently discard
 * whatever had been typed into it. Kept in the DOM and hidden, the section can
 * be closed and reopened with the edit intact.
 *
 * The trigger states BOTH halves — an icon that rotates and the word "Settings"
 * beside a chevron — and carries `aria-expanded` through the primitive, so its
 * state survives greyscale and a screen reader.
 */
export function SettingsDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border bg-card px-4 py-3 text-left grade-surface shadow-raised transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <Settings2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold">Settings</span>
        <span className="truncate text-xs text-muted-foreground">
          Name, URL, routing and turnaround
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent keepMounted>
        <div className="mt-3 rounded-lg border bg-card p-6 grade-surface shadow-raised-lg">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

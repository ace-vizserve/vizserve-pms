"use client";

import { useState } from "react";
import { ChevronDown, UserCog } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth/client-auth";
import type { Role } from "@/lib/auth/roles";
import { browserClient } from "@/lib/query/browser-client";
import { ROLE_LABELS } from "@/lib/schemas/users";
import { cn } from "@/lib/utils";

/**
 * P14-05 — THE ROLE SWITCHER, in the top bar on every page.
 *
 * Shown only to somebody who holds more than one role. Switching calls
 * `vizserve_pms_switch_role`, which refuses a role you do not hold and records
 * the change; the role you switch to is the one you are signed in as next time.
 *
 * ⚠️ A FULL PAGE LOAD AFTERWARDS, NOT `router.refresh()`. Every cached query and
 * every server-rendered screen was produced for the old role; reloading is the
 * one way to be sure nothing from it is still on screen.
 */
export function RoleSwitcher() {
  const auth = useAuth();
  const [pending, setPending] = useState(false);
  const held = auth.heldRoles ?? [auth.role];

  if (held.length < 2) return null;

  async function switchTo(next: Role) {
    if (next === auth.role || pending) return;
    setPending(true);

    const { error } = await browserClient().rpc("vizserve_pms_switch_role", { p_role: next });

    if (error) {
      setPending(false);
      toast.error(error.message || "Could not switch roles.");
      return;
    }

    // A deliberate full load — see the note above the component.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Acting as ${ROLE_LABELS[auth.role].label}. Switch role`}
        disabled={pending}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "gap-1.5 border-accent-border bg-accent text-accent-foreground",
        )}
      >
        <UserCog aria-hidden className="size-4" />
        <span className="hidden text-xs text-accent-foreground/80 sm:inline">Acting as</span>
        <span className="font-semibold">{ROLE_LABELS[auth.role].label}</span>
        <ChevronDown aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            Switch role
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={auth.role}
            onValueChange={(value) => void switchTo(value as Role)}
          >
            {[...held].reverse().map((role) => (
              <DropdownMenuRadioItem key={role} value={role} disabled={pending}>
                {ROLE_LABELS[role].label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, UserCog } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
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
 * P14-05 — switch the caller's active role, then reload.
 *
 * ⚠️ A FULL PAGE LOAD AFTERWARDS, NOT `router.refresh()`. Every cached query and
 * every server-rendered screen was produced for the old role; reloading is the
 * one way to be sure nothing from it is still on screen.
 */
function useSwitchRole() {
  const [pending, setPending] = useState(false);

  async function switchTo(next: Role, current: Role) {
    if (next === current || pending) return;
    setPending(true);

    const { error } = await browserClient().rpc("vizserve_pms_switch_role", { p_role: next });

    if (error) {
      setPending(false);
      toast.error(error.message || "Could not switch roles.");
      return;
    }

    // A deliberate full load — see the note above.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }

  return { pending, switchTo };
}

/**
 * P14-08 — how much is waiting under each role this person holds.
 *
 * Counts only, from `vizserve_pms_pending_by_role`, which reads past the
 * caller's own policies (acting as Team Leader hides the Manager's queue).
 * Only asked for by somebody who holds more than one role.
 */
function usePendingByRole(): Partial<Record<Role, number>> {
  const auth = useAuth();
  const held = auth.heldRoles ?? [auth.role];

  const { data } = useQuery({
    queryKey: ["pending-by-role", auth.userId],
    enabled: held.length > 1,
    // Realtime is the primary signal: a new notification invalidates this key
    // (`RealtimeNotifications`). The slow poll only catches items somebody
    // else cleared, which send you no notification.
    staleTime: 60_000,
    refetchInterval: 10 * 60_000,
    queryFn: async () => {
      const { data: rows, error } = await browserClient().rpc("vizserve_pms_pending_by_role");
      // Before the migration is applied the function does not exist; say
      // nothing rather than break the top bar.
      if (error) return [];
      return rows ?? [];
    },
  });

  return Object.fromEntries((data ?? []).map((row) => [row.role, row.pending]));
}

/**
 * P14-05 — THE ROLE SWITCHER, in the top bar on every page. Shown only to
 * somebody who holds more than one role. P14-08 adds a count beside each other
 * role that has work waiting.
 */
export function RoleSwitcher() {
  const auth = useAuth();
  const { pending, switchTo } = useSwitchRole();
  const waiting = usePendingByRole();
  const held = auth.heldRoles ?? [auth.role];

  if (held.length < 2) return null;

  const waitingElsewhere = held.some((role) => role !== auth.role && (waiting[role] ?? 0) > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Acting as ${ROLE_LABELS[auth.role].label}. Switch role${
          waitingElsewhere ? " — work is waiting under another role" : ""
        }`}
        disabled={pending}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "relative gap-1.5 border-accent-border bg-accent text-accent-foreground",
        )}
      >
        <UserCog aria-hidden className="size-4" />
        <span className="hidden text-xs text-accent-foreground/80 sm:inline">Acting as</span>
        <span className="font-semibold">{ROLE_LABELS[auth.role].label}</span>
        <ChevronDown aria-hidden className="size-3.5" />
        {waitingElsewhere ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 size-2.5 rounded-full border border-panel bg-warning"
          />
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            Switch role
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={auth.role}
            onValueChange={(value) => void switchTo(value as Role, auth.role)}
          >
            {[...held].reverse().map((role) => {
              const count = role === auth.role ? 0 : (waiting[role] ?? 0);
              return (
                <DropdownMenuRadioItem key={role} value={role} disabled={pending}>
                  <span className="flex-1">{ROLE_LABELS[role].label}</span>
                  {count > 0 ? (
                    <span className="rounded-sm border border-warning-border bg-warning-subtle px-1.5 text-2xs font-semibold text-warning">
                      {count} waiting
                    </span>
                  ) : null}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * P14-08 — THE NOTICE BAR under the top bar: "3 approvals are waiting on you as
 * Manager — Switch to Manager". One line per other role with work pending;
 * nothing at all otherwise.
 */
export function RolePendingNotice() {
  const auth = useAuth();
  const { pending, switchTo } = useSwitchRole();
  const waiting = usePendingByRole();
  const held = auth.heldRoles ?? [auth.role];

  const others = [...held]
    .reverse()
    .filter((role) => role !== auth.role && (waiting[role] ?? 0) > 0);

  if (others.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 border-b border-warning-border bg-warning-subtle px-4.5 py-2">
      {others.map((role) => {
        const count = waiting[role] ?? 0;
        const label = ROLE_LABELS[role].label;
        return (
          <div key={role} role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-foreground">
              <span className="font-semibold">
                {count} {count === 1 ? "item is" : "items are"}
              </span>{" "}
              waiting on you as {label}.
            </span>
            <Button
              size="xs"
              variant="outline"
              loading={pending}
              onClick={() => void switchTo(role, auth.role)}
            >
              Switch to {label}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

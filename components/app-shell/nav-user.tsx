"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { signOut } from "@/app/login/actions";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  team_leader: "Team Leader",
  manager: "Manager",
  admin: "Admin",
};

/**
 * The signed-in user block in the sidebar footer.
 *
 * The upstream version hardcodes its avatar initials and offers Upgrade to Pro
 * and Billing. Ours derives initials from the real name and shows the thing
 * that is genuinely invisible everywhere else: which departments this person
 * leads. That set — not the role — is what decides the contents of every list
 * they open, so it is worth surfacing.
 */
export function NavUser({
  fullName,
  email,
  role,
  departments,
}: {
  fullName: string;
  email: string;
  role: string;
  departments: string[];
}) {
  const { isMobile } = useSidebar();

  const displayName = fullName.trim() || email;
  const initials =
    displayName
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="h-13 border bg-card grade-raised shadow-raised hover:bg-card"
              />
            }
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-accent-border bg-accent grade-chip text-xs font-semibold text-accent-foreground shadow-raised">
              {initials}
            </span>
            <span className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-semibold tracking-[-0.014em]">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{email}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            side={isMobile ? "bottom" : "right"}
            className="w-64"
          >
            {/* The Group is required, not decoration. DropdownMenuLabel is
                Base UI's Menu.GroupLabel, which reads MenuGroupContext to point
                its group's aria-labelledby at itself — outside a Group that
                context is missing and Base UI throws outright. This label was
                sitting bare, so every authenticated page raised it. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{displayName}</p>
                  <p className="text-xs text-muted-foreground">{email}</p>
                  <p className="pt-1">
                    <span className="inline-flex h-5.25 items-center rounded-sm border bg-muted grade-chip px-2 text-2xs font-semibold text-foreground-muted">
                      {ROLE_LABELS[role] ?? role}
                    </span>
                  </p>
                  {departments.length > 0 ? (
                    <p className="pt-1 text-xs text-muted-foreground">
                      Leads: {departments.join(", ")}
                    </p>
                  ) : null}
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            {/* A form, not an onClick: sign-out is a server action and must
                survive JavaScript being unavailable or still loading.

                `nativeButton` is the other half of that decision. Menu.Item
                defaults it to FALSE — a menu item is normally a div with
                role="menuitem" — so handing it a real <button> makes Base UI
                warn that it is about to add non-native attributes on top of
                native behaviour. The button is deliberate here, so the honest
                fix is to say so rather than to give up the form. */}
            <form action={signOut}>
              <DropdownMenuItem nativeButton render={<button type="submit" className="w-full" />}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
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
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-xs font-medium text-sidebar-primary-foreground">
              {initials}
            </span>
            <span className="grid flex-1 text-left leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{email}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            side={isMobile ? "bottom" : "right"}
            className="w-64"
          >
            <DropdownMenuLabel className="font-normal">
              <div className="space-y-1">
                <p className="text-sm font-medium">{displayName}</p>
                <p className="text-xs text-muted-foreground">{email}</p>
                <p className="pt-1">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
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

            <DropdownMenuSeparator />

            {/* A form, not an onClick: sign-out is a server action and must
                survive JavaScript being unavailable or still loading. */}
            <form action={signOut}>
              <DropdownMenuItem render={<button type="submit" className="w-full" />}>
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

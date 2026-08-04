"use client";

import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/app/login/actions";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  team_leader: "Team Leader",
  manager: "Manager",
  admin: "Admin",
};

export function UserMenu({
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
  const displayName = fullName.trim() || email;
  const initials =
    displayName
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="h-auto gap-2 px-2 py-1.5" />}>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
            {initials}
          </span>
          <span className="hidden text-sm sm:inline">{displayName}</span>
        </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="space-y-1">
            <p className="text-sm font-medium">{displayName}</p>
            <p className="text-xs text-muted-foreground">{email}</p>
            <p className="pt-1 text-xs">
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
                {ROLE_LABELS[role] ?? role}
              </span>
            </p>
            {/* Which departments you LEAD, which is not your role and not your
                own department. Worth showing: it is the thing that decides what
                you can see, and it is invisible everywhere else. */}
            {departments.length > 0 ? (
              <p className="pt-1 text-xs text-muted-foreground">Leads: {departments.join(", ")}</p>
            ) : null}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <form action={signOut}>
          <button type="submit" className="w-full">
            <DropdownMenuItem render={<span className="cursor-pointer" />}>
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

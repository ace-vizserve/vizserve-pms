"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL = "__all__";

/**
 * In the URL, like every other filter here, so a lead can bookmark one team.
 * The server checks the value against the departments this viewer may read —
 * a pasted id from somebody else's department falls back to "all of mine".
 */
export function DepartmentFilter({
  departments,
  allLabel,
}: {
  departments: { id: string; name: string }[];
  allLabel: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI renders the raw value in <SelectValue> unless handed an items map.
  const items: Record<string, string> = {
    [ALL]: allLabel,
    ...Object.fromEntries(departments.map((department) => [department.id, department.name])),
  };

  function choose(value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete("department");
    else next.set("department", value);
    const query = next.toString();
    router.push(query ? `/analytics?${query}` : "/analytics");
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card grade-surface p-3 shadow-raised-lg">
      <div className="space-y-1.5">
        <Label htmlFor="department" className="text-xs text-muted-foreground">
          Department
        </Label>
        <Select items={items} value={params.get("department") ?? ALL} onValueChange={choose}>
          <SelectTrigger id="department" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{allLabel}</SelectItem>
            {departments.map((department) => (
              <SelectItem key={department.id} value={department.id}>
                {department.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Rows-per-page. Client-side because a `<select>` has to react to a choice;
 * everything else about pagination stays server-rendered links.
 *
 * Changing the size ALWAYS returns to page 1. Page 5 of 20-per-page is row 81,
 * which at 100-per-page does not exist — staying put would land the reader on
 * an empty page and look broken.
 */
export function PageSizeSelect({
  value,
  options,
  basePath,
}: {
  value: number;
  options: readonly number[];
  /** e.g. `/inbox`. Other filters in the URL are preserved. */
  basePath: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI's Select emits `string | null` — null on clear. There is no clear
  // affordance here, but the signature has to match or the handler silently
  // stops being called on a version bump.
  function change(next: string | null) {
    if (!next) return;

    const query = new URLSearchParams(params.toString());

    // The default is the absence of the param, so the common URL stays clean.
    if (Number(next) === options[0]) query.delete("size");
    else query.set("size", next);

    query.delete("page");

    const search = query.toString();
    router.push(search ? `${basePath}?${search}` : basePath);
  }

  return (
    <Select
      // Same string on both sides today, mapped anyway — see
      // scripts/check-select-items.mjs for why there is no exemption list.
      items={Object.fromEntries(options.map((option) => [String(option), String(option)]))}
      value={String(value)}
      onValueChange={change}>
      {/* Labelled, because "20" on its own is meaningless to a screen reader. */}
      <SelectTrigger size="sm" className="w-20" aria-label="Rows per page">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={String(option)}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { downloadPdf } from "@/lib/download-file";

import { exportLeaveReport } from "./actions";

type Option = { id: string; label: string; muted?: boolean };

type Mode = "annual" | "taken";

/**
 * P7-53 — the report builder.
 *
 * ⚠️ A FILTER IS EITHER "EVERYTHING" OR A NON-EMPTY SELECTION, never an empty
 * one. Nothing ticked means no filter at all, and the payload sends `undefined`
 * rather than `[]` — the schema refuses an empty array, because both SQL
 * functions read null as "everything in scope" and `[]` would mean "match
 * nothing", producing a PDF with a header, a footer and no rows. On an audit
 * document that is indistinguishable from a broken export.
 */
export function ReportBuilder({
  currentYear,
  today,
  people,
  departments,
  leaveTypes,
}: {
  currentYear: number;
  today: string;
  people: { id: string; full_name: string; is_active: boolean }[];
  departments: { id: string; name: string }[];
  leaveTypes: { id: string; label: string; is_active: boolean }[];
}) {
  const [pending, startExport] = useTransition();
  const [mode, setMode] = useState<Mode>("annual");
  const [year, setYear] = useState(String(currentYear));

  // Defaults to the current month, which is the commonest question this mode is
  // asked. Held as strings because that is what a date input reports.
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);

  const [userIds, setUserIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [leaveTypeIds, setLeaveTypeIds] = useState<string[]>([]);

  const peopleOptions: Option[] = people.map((person) => ({
    id: person.id,
    label: person.full_name,
    muted: !person.is_active,
  }));
  const departmentOptions: Option[] = departments.map((d) => ({ id: d.id, label: d.name }));
  const typeOptions: Option[] = leaveTypes.map((type) => ({
    id: type.id,
    label: type.label,
    muted: !type.is_active,
  }));

  function download() {
    const filters = {
      // undefined, NOT []. See the note at the top of this file.
      userIds: userIds.length > 0 ? userIds : undefined,
      departmentIds: departmentIds.length > 0 ? departmentIds : undefined,
      leaveTypeIds: leaveTypeIds.length > 0 ? leaveTypeIds : undefined,
    };

    const input =
      mode === "annual"
        ? { mode, year, ...filters }
        : { mode, from, to, ...filters };

    startExport(async () => {
      const result = await exportLeaveReport(input);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      downloadPdf(result.data.base64, result.data.filename);
      toast.success("Report downloaded.");
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label>Report</Label>
        <Segmented value={mode} onValueChange={(value) => setMode((value ?? "annual") as Mode)}>
          <SegmentedItem value="annual">Annual balance audit</SegmentedItem>
          <SegmentedItem value="taken">Leave taken</SegmentedItem>
        </Segmented>
        <p className="text-xs text-muted-foreground">
          {mode === "annual"
            ? "Allocated, used and unused for one calendar year — the document signed and filed in December."
            : "Every approved absence overlapping the period, with days counted for the overlap. Leave that runs past either end is marked, and only the days inside the period are counted."}
        </p>
      </div>

      {mode === "annual" ? (
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="year">Calendar year</Label>
          <Input
            id="year"
            type="number"
            min={2020}
            max={2100}
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from">From</Label>
            <Input
              id="from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <FilterBox
          title="Staff"
          options={peopleOptions}
          selected={userIds}
          onChange={setUserIds}
        />
        <FilterBox
          title="Department"
          options={departmentOptions}
          selected={departmentIds}
          onChange={setDepartmentIds}
        />
        <FilterBox
          title="Leave type"
          options={typeOptions}
          selected={leaveTypeIds}
          onChange={setLeaveTypeIds}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={download} disabled={pending}>
          <Download className="size-4" aria-hidden />
          {pending ? "Building…" : "Download PDF"}
        </Button>
        <p className="text-xs text-muted-foreground">
          The PDF names every filter applied, who ran it and what they could see.
        </p>
      </div>
    </div>
  );
}

/**
 * One filter: a scrollable list of checkboxes and a count.
 *
 * "Everyone" is the state where NOTHING is ticked, said in as many words rather
 * than left to be inferred from an empty list — an unticked filter looks
 * identical to a filter somebody forgot to fill in.
 */
function FilterBox({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...new Set([...selected, id])] : selected.filter((value) => value !== id));
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label>{title}</Label>
        {selected.length === 0 ? (
          <Badge variant="secondary">All</Badge>
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => onChange([])}
          >
            {selected.length} selected — clear
          </button>
        )}
      </div>

      <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing to choose from.</p>
        ) : (
          options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-2 text-sm"
              htmlFor={`${title}-${option.id}`}
            >
              <Checkbox
                id={`${title}-${option.id}`}
                checked={selected.includes(option.id)}
                onCheckedChange={(checked) => toggle(option.id, checked === true)}
              />
              <span className={option.muted ? "text-muted-foreground" : undefined}>
                {option.label}
                {option.muted ? " (retired)" : ""}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

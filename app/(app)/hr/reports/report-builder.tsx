"use client";

import { Download } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { downloadPdf } from "@/lib/download-file";
import { cn } from "@/lib/utils";

import { exportLeaveReport } from "./actions";

type Option = { id: string; label: string; muted?: boolean };

type Mode = "annual" | "taken";

/**
 * The two documents, and the sentence that tells them apart, in one place.
 *
 * The wording used to live in a ternary beside the control and again in the
 * page's intro paragraph, which is how the page ended up explaining the same
 * distinction twice in two different sets of words.
 */
const DOCUMENTS: { value: Mode; label: string; description: string }[] = [
  {
    value: "annual",
    label: "Annual balance audit",
    description:
      "Allocated, used and unused for one calendar year — the document signed and filed in December.",
  },
  {
    value: "taken",
    label: "Leave taken",
    description:
      "Every approved absence overlapping the period, counted for the overlap. Leave running past either end is marked. No allocation is shown — allocation is annual, so a part-year figure would not be true of anything.",
  },
];

/**
 * P7-53 — the report builder.
 *
 * ⚠️ A FILTER IS EITHER "EVERYTHING" OR A NON-EMPTY SELECTION, never an empty
 * one. Nothing ticked means no filter at all, and the payload sends `undefined`
 * rather than `[]` — the schema refuses an empty array, because both SQL
 * functions read null as "everything in scope" and `[]` would mean "match
 * nothing", producing a PDF with a header, a footer and no rows. On an audit
 * document that is indistinguishable from a broken export.
 *
 * ------------------------------------------------------------------------
 * P7-62 — THE SCREEN IS A FORM NOW, AND IT LOOKS LIKE ONE.
 *
 * It had no container. A paragraph of 12px grey, a segmented control, an input
 * and a button all floated directly on the page ground, and the only bordered
 * things anywhere were the three filter lists — so the OPTIONAL part of the
 * form carried all of the visible structure while the part that decides which
 * document you get carried none. The three boxes also had a border and no fill,
 * which the design system does not have a plane for: a flat thing is a fill AND
 * a border (§1.5).
 *
 * So: one `Card`, a header that names the job, the document and its period
 * above a full-bleed rule, the filters below it, and the export in a
 * `CardFooter` — the same footer bar every dialog in this app puts its
 * confirming action in.
 *
 * ⚠️ AND THE FOOTER STATES WHAT WILL COME OUT, in words. "Nothing ticked means
 * everything" is true and was written down, but it made the commonest state —
 * three untouched lists — indistinguishable from three lists somebody forgot to
 * fill in. A person about to export an audit document should be able to read
 * back what they are exporting without re-scanning three scroll panes.
 * ------------------------------------------------------------------------
 */
export function ReportBuilder({
  currentYear,
  today,
  people,
  departments,
  leaveTypes,
  chrome = "card",
}: {
  currentYear: number;
  today: string;
  people: { id: string; full_name: string; is_active: boolean }[];
  departments: { id: string; name: string }[];
  leaveTypes: { id: string; label: string; is_active: boolean }[];
  /**
   * ⚠️ THIS COMPONENT HAS TWO HOMES AND ONLY ONE OF THEM SUPPLIES ITS OWN BOX.
   *
   * `/hr/reports` is a page, so the builder brings the `Card` — the header, the
   * rule and the footer bar are its own. `/admin/users` renders the same
   * builder inside a "Leave audit" dialog that has already drawn a
   * `DialogHeader` and a title, and a card inside a dialog is a panel inside a
   * panel: two borders, two shadows and two headings saying the same thing.
   *
   * So `bare` drops the chrome and keeps the body, ending in a footer bar that
   * matches `DialogFooter` exactly — same full-bleed offsets, same `bg-muted/50`
   * — because it is standing in for one.
   */
  chrome?: "card" | "bare";
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

    const input = mode === "annual" ? { mode, year, ...filters } : { mode, from, to, ...filters };

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

  /*
   * WHAT THE PDF WILL CONTAIN, read back as a sentence.
   *
   * Each clause names the count when a filter is set and says "every …" when it
   * is not, so an untouched form reads as a deliberate choice rather than as an
   * unfinished one. Deliberately not a list of names: at sixteen staff it would
   * wrap to three lines and stop being scannable, and the ticked boxes are
   * directly above.
   */
  const description = DOCUMENTS.find((document) => document.value === mode)?.description ?? "";

  const summary = [
    describe(userIds.length, "person", "people", "Everyone"),
    describe(departmentIds.length, "department", "departments", "every department"),
    describe(leaveTypeIds.length, "leave type", "leave types", "every leave type"),
  ].join(" · ");

  const body = (
    <>
      {/*
        ⚠️ THE CRAMPING WAS MISSING PADDING, and the primitive says so:
        `segmentedItem` ships with none, because "a labelled segment wants
        px-2.5 py-1, an icon-only one wants a square — the caller decides", and
        this caller decided nothing. The two labels sat edge to edge in a 4px
        track.

        It stays a segmented control on ONE ROW with the period beside it. An
        earlier pass grew it into two full-width description cards, which was
        more furniture than a two-way choice can carry: this is a filter bar,
        and the difference between the documents is one line of text, not a
        layout.
      */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex flex-col gap-1.5">
          <p id="report-mode" className="text-sm font-medium">
            Document
          </p>
          <Segmented
            aria-labelledby="report-mode"
            value={mode}
            onValueChange={(value) => setMode((value ?? "annual") as Mode)}>
            {DOCUMENTS.map((document) => (
              <SegmentedItem key={document.value} value={document.value} className="h-8 px-3">
                {document.label}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>

        {mode === "annual" ? (
          <div className="flex w-28 flex-col gap-1.5">
            <Label htmlFor="year">Calendar year</Label>
            <Input
              id="year"
              type="number"
              min={2020}
              max={2100}
              value={year}
              onChange={(event) => setYear(event.target.value)}
              className="h-8 tabular-nums"
            />
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {/*
              ⚠️ `DatePicker`, NOT `<Input type="date">`. These two were native
              date inputs, which is the anti-pattern §2 names first: the browser
              draws its own calendar, so the popup arrives with Chrome's blue
              selection, Chrome's "Clear / Today" links and no dark mode, sitting
              beside controls that have all three from our tokens. It also
              renders the value in the BROWSER's locale — "01/09/2026" is 1
              September here and 9 January to a machine set to en-US, on a
              report whose whole output is a date range.
            */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from">From</Label>
              <DatePicker
                id="from"
                value={from}
                onChange={(value) => setFrom(value ?? "")}
                max={to || undefined}
                clearable={false}
                className="h-8"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="to">To</Label>
              <DatePicker
                id="to"
                value={to}
                onChange={(value) => setTo(value ?? "")}
                min={from || undefined}
                clearable={false}
                className="h-8"
              />
            </div>
          </div>
        )}

        {/* One line, for the document that is actually selected. */}
        <p className="w-full text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>

      {/* Full-bleed rule. Both homes pad by 4, so the same negative margin
          reaches the edge in a card and in a dialog. */}
      <div className="-mx-4 space-y-3 border-t px-4 pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Narrow it
          </h3>
          <p className="text-2xs text-muted-foreground">
            Nothing ticked means everything you are allowed to see.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
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
      </div>
    </>
  );

  const action = (
    <>
      <p className="min-w-0 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">This PDF: </span>
        {summary}
      </p>
      <Button onClick={download} loading={pending}>
        <Download aria-hidden />
        Download PDF
      </Button>
    </>
  );

  // In a dialog the header is already drawn and the box already exists, so the
  // builder contributes the body and a footer bar shaped like `DialogFooter`.
  if (chrome === "bare") {
    return (
      <div className="space-y-5">
        {body}
        <div className="-mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t bg-muted/50 p-4">
          {action}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Build a leave report</CardTitle>
        <CardDescription>
          Choose the document, set its period, then narrow it if you need to. Every PDF prints the
          filters it applied, who ran it and what they could see.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">{body}</CardContent>

      <CardFooter className="flex-wrap justify-between gap-3">{action}</CardFooter>
    </Card>
  );
}

/** "Everyone" / "1 person" / "4 people" — the count, or the word for all of them. */
function describe(count: number, one: string, many: string, all: string): string {
  if (count === 0) return all;
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One filter: a scrollable list of checkboxes and a count.
 *
 * "All" is the state where NOTHING is ticked, said in as many words rather than
 * left to be inferred from an empty list — an unticked filter looks identical to
 * a filter somebody forgot to fill in.
 *
 * FLAT, and now with the fill a flat thing is supposed to have. It was a bare
 * `border` over the page ground, which is neither of the system's two planes
 * (§1.5): raised is a fill plus a lift, flat is a fill plus a border. Inside a
 * white card the muted fill is also what makes the three lists read as one group
 * of inputs rather than as three more panels.
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
    <div className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        {/* A heading, not a <Label> — there is no single control for it to
            name, and a label pointing at nothing is a label a screen reader
            announces and then cannot follow. */}
        <p className="text-sm font-medium">{title}</p>
        {selected.length === 0 ? (
          <Badge variant="secondary">All</Badge>
        ) : (
          // The primitive, not a bare <button>: it carries the focus ring, the
          // disabled semantics and the seven states the hand-rolled one had to
          // reinvent and got two of.
          <Button
            variant="ghost"
            size="xs"
            className="-mr-1.5 text-muted-foreground"
            onClick={() => onChange([])}>
            {selected.length} selected — clear
          </Button>
        )}
      </div>

      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing to choose from.</p>
        ) : (
          options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-accent/60"
              htmlFor={`${title}-${option.id}`}>
              <Checkbox
                id={`${title}-${option.id}`}
                checked={selected.includes(option.id)}
                onCheckedChange={(checked) => toggle(option.id, checked === true)}
              />
              <span
                title={option.label}
                className={cn("min-w-0 truncate", option.muted && "text-muted-foreground")}>
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

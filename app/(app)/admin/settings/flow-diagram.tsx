"use client";

import { useId } from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * P14-12 — A PROCESS, DRAWN AS A FLOWCHART.
 *
 * Fixed geometry, so it renders the same at every width (it scrolls sideways
 * inside itself; the page never does):
 *
 *   [1] ──▶ [2] ──▶ [3] ──▶ [4] ──┬──▶ [✓ Approved]
 *    ▲               ▲      │      └──▶ [✕ Rejected]
 *    └── Sent back ──┘      │
 *                           └──▶ Cancelled · ends
 *
 * Steps run left to right with arrows between them; the outcomes fork off the
 * last step. Every side event is drawn under the step it leaves from: a LOOP
 * curving back to the step the work returns to, or a DROP to "ends" when it
 * finishes the process. Boxes and labels are buttons — clicking one selects
 * that stage.
 */

export type FlowNode = {
  key: string;
  label: string;
  /** Who acts at this stage, for the second line of a box. */
  acts?: string;
};

export type FlowBranch = FlowNode & {
  /** Index into `steps` the branch leaves from. */
  from: number;
  /** Index into `steps` the work returns to; null = it ends the process. */
  to: number | null;
};

export type FlowOutcome = FlowNode & { tone: "success" | "danger" | "neutral" };

const W = 176; // box width
const H = 64; // box height
const GAP = 64; // horizontal space between boxes (holds the arrow)
const LANE = 52; // vertical space per branch lane
const OUT_GAP = 12; // between stacked outcomes

const colX = (index: number) => index * (W + GAP);

export function FlowDiagram({
  steps,
  outcomes,
  branches,
  selected,
  onSelect,
}: {
  steps: FlowNode[];
  outcomes: FlowOutcome[];
  branches: FlowBranch[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const markerId = `arrow-${useId().replace(/:/g, "")}`;

  const outcomeCol = steps.length;
  const outcomesHeight = outcomes.length > 0 ? outcomes.length * H + (outcomes.length - 1) * OUT_GAP : 0;
  const mainHeight = Math.max(H, outcomesHeight);
  const stepTop = (mainHeight - H) / 2;
  const lanesTop = mainHeight + 28;
  const width = colX(outcomes.length > 0 ? outcomeCol : steps.length - 1) + W;
  const height = lanesTop + branches.length * LANE + (branches.length > 0 ? 8 : 0);

  const stepMidY = stepTop + H / 2;
  const stepBottom = stepTop + H;

  const lines: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];

  // Main arrows between consecutive steps.
  for (let i = 1; i < steps.length; i += 1) {
    lines.push(
      <line
        key={`main-${i}`}
        x1={colX(i - 1) + W}
        y1={stepMidY}
        x2={colX(i) - 4}
        y2={stepMidY}
        markerEnd={`url(#${markerId})`}
      />,
    );
  }

  // The fork from the last step to each outcome.
  outcomes.forEach((outcome, k) => {
    const x1 = colX(steps.length - 1) + W;
    const x2 = colX(outcomeCol) - 4;
    const midX = x1 + GAP / 2;
    const y2 = k * (H + OUT_GAP) + H / 2;
    lines.push(
      <path
        key={`out-${outcome.key}`}
        d={`M ${x1} ${stepMidY} H ${midX} V ${y2} H ${x2}`}
        markerEnd={`url(#${markerId})`}
      />,
    );
  });

  // Branches: a loop back, or a drop to "ends".
  branches.forEach((branch, lane) => {
    const y = lanesTop + lane * LANE + LANE / 2 - 10;
    const fromCenter = colX(branch.from) + W / 2;

    if (branch.to === null) {
      const x1 = fromCenter + 18;
      const xEnd = x1 + 36;
      lines.push(<path key={`b-${branch.key}`} d={`M ${x1} ${stepBottom} V ${y} H ${xEnd}`} />);
      labels.push(
        <BranchLabel
          key={branch.key}
          branch={branch}
          note="ends it"
          left={xEnd + 4}
          top={y}
          anchor="start"
          selected={selected === branch.key}
          onSelect={onSelect}
        />,
      );
      return;
    }

    const toCenter = colX(branch.to) + W / 2;
    const x1 = fromCenter + 14;
    const x2 = (branch.to === branch.from ? toCenter - 14 : toCenter - 14);
    lines.push(
      <path
        key={`b-${branch.key}`}
        d={`M ${x1} ${stepBottom} V ${y} H ${x2} V ${stepBottom + 4}`}
        markerEnd={`url(#${markerId})`}
      />,
    );
    labels.push(
      <BranchLabel
        key={branch.key}
        branch={branch}
        note={`back to ${branch.to + 1}`}
        left={(x1 + x2) / 2}
        top={y}
        anchor="middle"
        selected={selected === branch.key}
        onSelect={onSelect}
      />,
    );
  });

  return (
    <div className="overflow-x-auto rounded-lg border bg-muted/40 p-5">
      <div className="relative mx-auto" style={{ width, height }}>
        <svg
          aria-hidden
          width={width}
          height={height}
          className="absolute inset-0 fill-none stroke-foreground-faint"
          strokeWidth={1.5}
        >
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-foreground-faint stroke-none" />
            </marker>
          </defs>
          {lines}
        </svg>

        {steps.map((step, index) => (
          <Box
            key={step.key}
            node={step}
            left={colX(index)}
            top={stepTop}
            marker={<span className="text-2xs font-semibold tabular-nums">{index + 1}</span>}
            selected={selected === step.key}
            onSelect={onSelect}
          />
        ))}

        {outcomes.map((outcome, k) => (
          <Box
            key={outcome.key}
            node={outcome}
            left={colX(outcomeCol)}
            top={k * (H + OUT_GAP)}
            tone={outcome.tone}
            marker={outcome.tone === "success" ? <Check className="size-3.5" /> : <X className="size-3.5" />}
            selected={selected === outcome.key}
            onSelect={onSelect}
          />
        ))}

        {labels}
      </div>
    </div>
  );
}

function Box({
  node,
  left,
  top,
  marker,
  tone,
  selected,
  onSelect,
}: {
  node: FlowNode;
  left: number;
  top: number;
  marker: React.ReactNode;
  tone?: "success" | "danger" | "neutral";
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      onClick={() => onSelect(node.key)}
      style={{ left, top, width: W, height: H }}
      className={cn(
        "absolute h-auto justify-start gap-2.5 rounded-lg px-3 text-left whitespace-normal",
        tone === "success" && "border-success-border bg-success-subtle",
        tone === "danger" && "border-destructive-border bg-destructive-subtle",
        selected && "border-primary ring-2 ring-primary/30",
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border",
          !tone && (selected ? "border-primary bg-primary text-primary-foreground" : "border-accent-border bg-accent text-accent-foreground"),
          tone === "success" && "border-success bg-success text-background",
          tone === "danger" && "border-destructive bg-destructive text-background",
          tone === "neutral" && "border-border bg-muted text-foreground-muted",
        )}
      >
        {marker}
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 text-xs leading-tight font-semibold">{node.label}</span>
        {node.acts ? <span className="block truncate text-2xs text-muted-foreground">{node.acts}</span> : null}
      </span>
    </Button>
  );
}

function BranchLabel({
  branch,
  note,
  left,
  top,
  anchor,
  selected,
  onSelect,
}: {
  branch: FlowBranch;
  note: string;
  left: number;
  top: number;
  anchor: "start" | "middle";
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      onClick={() => onSelect(branch.key)}
      style={{ left, top }}
      className={cn(
        "absolute h-auto -translate-y-1/2 px-2 py-1 text-2xs font-normal whitespace-nowrap",
        anchor === "middle" && "-translate-x-1/2",
        selected && "border-primary ring-2 ring-primary/30",
      )}
    >
      <span className="font-medium">{branch.label}</span>
      <span className="text-muted-foreground"> · {note}</span>
    </Button>
  );
}

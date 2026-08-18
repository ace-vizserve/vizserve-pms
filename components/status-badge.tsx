import type { LucideIcon } from "lucide-react";
import {
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleCheckBig,
  CircleSlash,
  ClipboardCheck,
  ScanSearch,
  SendHorizontal,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  VizservePmsInternalRequestStatus,
  VizservePmsInternalRequestType,
  VizservePmsRequestStatus,
  VizservePmsTaskStatus,
} from "@/lib/database.types";
import { INTERNAL_REQUEST_LABELS } from "@/lib/schemas/internal-requests";
import { TASK_STATUS_LABELS } from "@/lib/schemas/tasks";

/**
 * Every pill in the app is this shape. It lived in three places before —
 * `app/(app)/approvals/request-summary.tsx` had a second, near-identical copy
 * that had already drifted to `font-semibold` — which is exactly how two badges
 * for the same idea end up different heights on the same screen.
 *
 * The refresh makes it a chip rather than a full pill: 21px tall, on the radius
 * scale, with a hairline border, the `grade-chip` wash for a lit top edge, and a
 * leading dot. The border and the wash are what stop a neutral chip vanishing
 * into a white card, which the old flat fill did.
 */
const PILL =
  "inline-flex h-7 shrink-0 items-center gap-2 rounded-md border grade-chip px-2.5 text-2xs font-semibold whitespace-nowrap";

/**
 * The tones. Each is a subtle fill, its own border, and a solid for the text
 * and the dot — so a status reads at a glance without the colour ever being the
 * only thing carrying it.
 */
const TONE = {
  neutral: "border-border bg-muted text-foreground-muted",
  brand: "border-accent-border bg-accent text-accent-foreground",
  info: "border-info-border bg-info-subtle text-info",
  success: "border-success-border bg-success-subtle text-success",
  warning: "border-warning-border bg-warning-subtle text-warning",
  danger: "border-destructive-border bg-destructive-subtle text-destructive",
} as const;

type Tone = keyof typeof TONE;

/**
 * The dot is a SECOND non-colour carrier of state, not decoration: it inherits
 * `currentColor`, so in greyscale the chips still differ from one another by
 * fill and border weight, and the label always says which is which.
 *
 * `aria-hidden` because it duplicates the label for anyone reading the text.
 */
function Pill({
  tone,
  label,
  icon: Icon,
  className,
}: {
  tone: Tone;
  label: string;
  /**
   * Replaces the dot rather than joining it. An icon is the same second
   * non-colour carrier the dot is, only a stronger one — a board column reading
   * "pause" beside its label survives greyscale better than a tinted circle
   * does. Two markers on one chip would just be noise.
   */
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <span className={cn(PILL, TONE[tone], className)}>
      {Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <span aria-hidden className="size-1.25 shrink-0 rounded-full bg-current" />
      )}
      {label}
    </span>
  );
}

/**
 * Status pills for the canonical status sets (docs/01-updated-workflow.md §3).
 *
 * Two rules encoded here rather than left to call sites:
 *
 *   1. State is never conveyed by colour alone — every pill carries its label,
 *      so it survives greyscale, a screenshot and a printed queue.
 *   2. The label is human wording, not the enum. `PENDING_REVIEW` is a database
 *      value; "Awaiting review" is what a Team Leader scanning a queue reads.
 *      The enum stays canonical underneath and is never invented around.
 */

const REQUEST_STATUS: Record<VizservePmsRequestStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "neutral" },
  PENDING_REVIEW: { label: "Awaiting review", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  RETURNED: { label: "Returned", tone: "info" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

export function RequestStatusBadge({
  status,
  className,
}: {
  status: VizservePmsRequestStatus;
  className?: string;
}) {
  const config = REQUEST_STATUS[status] ?? { label: status, tone: "neutral" as const };

  return <Pill tone={config.tone} label={config.label} className={className} />;
}

export const REQUEST_STATUS_OPTIONS = (
  Object.keys(REQUEST_STATUS) as VizservePmsRequestStatus[]
).map((value) => ({ value, label: REQUEST_STATUS[value].label }));

/**
 * Narrows a URL parameter to a real status.
 *
 * Filters come from the query string, so the value is whatever someone typed.
 * An unknown status is dropped rather than passed to Postgres, where it would
 * fail enum casting and turn a mistyped bookmark into a 500.
 */
export function isRequestStatus(value: string | undefined): value is VizservePmsRequestStatus {
  return typeof value === "string" && value in REQUEST_STATUS;
}

/**
 * Task statuses (P3).
 *
 * Labels come from `lib/schemas/tasks.ts` rather than being restated here — that
 * module is the contract both tracks import, and a second copy of
 * "COMPLETED_NO_RESPONSE reads as Completed (no response)" is a second place for
 * it to drift.
 *
 * The two terminal states are styled DIFFERENTLY on purpose. `COMPLETED` means
 * the client approved; `COMPLETED_NO_RESPONSE` means the clock ran out and
 * nobody looked. Phase 6 reports the split, and a queue that renders them
 * identically hides the thing worth reporting.
 */
const TASK_STATUS_TONES: Record<VizservePmsTaskStatus, Tone> = {
  OPEN: "neutral",
  ONGOING: "brand",
  WAITING_FOR_INFO: "warning",
  // The two QA states use the brand tint (`--accent` / `--accent-foreground`),
  // not `--secondary`. Secondary is a near-white neutral, so a wash of it was an
  // invisible pill on a white card — the label carried the state and the fill
  // did nothing. `--accent` is #EDF0F8 with brand text at 5.79:1, and it flips
  // correctly in dark mode.
  FOR_QA: "brand",
  QA_IN_PROGRESS: "brand",
  FOR_CLIENT_APPROVAL: "warning",
  COMPLETED: "success",
  COMPLETED_NO_RESPONSE: "neutral",
};

/**
 * The glyph for each stage, used where a chip is a heading rather than a note —
 * the board's column headers (P3-04).
 *
 * It lives HERE, beside the tone map, for the same reason the tones do: a status
 * has one identity, and an icon picked at a call site is the second copy that
 * drifts. The shapes read as a sequence when the columns are seen side by side —
 * dashed outline, play, pause, clipboard, magnifier, send — so the board says
 * which way work flows before anyone reads a word of it.
 */
export const TASK_STATUS_ICONS: Record<VizservePmsTaskStatus, LucideIcon> = {
  OPEN: CircleDashed,
  ONGOING: CirclePlay,
  WAITING_FOR_INFO: CirclePause,
  FOR_QA: ClipboardCheck,
  QA_IN_PROGRESS: ScanSearch,
  FOR_CLIENT_APPROVAL: SendHorizontal,
  COMPLETED: CircleCheckBig,
  // Distinct from COMPLETED here too — same rule as the tones. The clock ran
  // out; nobody signed anything off.
  COMPLETED_NO_RESPONSE: CircleSlash,
};

/**
 * A status as a SURFACE rather than as a chip — the board column the chip heads.
 *
 * The wash is the same tone the pill uses, thinned so a white card still reads
 * as raised against it. It is a class string rather than a colour so the
 * mapping stays in this file, which is the only place a status is allowed to
 * become a colour (§4.1).
 *
 * Never the sole carrier of anything: the column is headed by a full chip with
 * its own icon and label, and this only tells the eye where one column stops.
 */
const TONE_SURFACE: Record<Tone, string> = {
  neutral: "border-border bg-muted",
  brand: "border-accent-border/60 bg-accent/60",
  info: "border-info-border/50 bg-info-subtle/45",
  success: "border-success-border/50 bg-success-subtle/45",
  warning: "border-warning-border/50 bg-warning-subtle/45",
  danger: "border-destructive-border/50 bg-destructive-subtle/45",
};

export function taskStatusSurface(status: VizservePmsTaskStatus): string {
  return TONE_SURFACE[TASK_STATUS_TONES[status] ?? "neutral"];
}

export function TaskStatusBadge({
  status,
  icon = false,
  className,
}: {
  status: VizservePmsTaskStatus;
  /** Swap the dot for the stage's glyph. Board column headings; not table cells. */
  icon?: boolean;
  className?: string;
}) {
  return (
    <Pill
      tone={TASK_STATUS_TONES[status] ?? "neutral"}
      label={TASK_STATUS_LABELS[status] ?? status}
      icon={icon ? TASK_STATUS_ICONS[status] : undefined}
      className={className}
    />
  );
}

export const TASK_STATUS_OPTIONS = (
  Object.keys(TASK_STATUS_TONES) as VizservePmsTaskStatus[]
).map((value) => ({ value, label: TASK_STATUS_LABELS[value] }));

export function isTaskStatus(value: string | undefined): value is VizservePmsTaskStatus {
  return typeof value === "string" && value in TASK_STATUS_TONES;
}

/**
 * Internal requests (P5) — leave, time corrections, reimbursements.
 *
 * A separate set from `REQUEST_STATUS` even though the three values overlap,
 * because the wording differs on purpose: a client request sits in "Awaiting
 * review" at a Team Leader's gate, while your own leave request reads "Pending"
 * to you. Merging them would force one label onto both screens.
 */
const INTERNAL_STATUS: Record<
  VizservePmsInternalRequestStatus,
  { label: string; tone: Tone }
> = {
  PENDING_REVIEW: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

export function InternalStatusBadge({
  status,
  className,
}: {
  status: VizservePmsInternalRequestStatus;
  className?: string;
}) {
  const config = INTERNAL_STATUS[status] ?? { label: status, tone: "neutral" as const };

  return <Pill tone={config.tone} label={config.label} className={className} />;
}

/** Which kind of internal request it is. Neutral — the status carries the state. */
export function InternalTypeBadge({
  type,
  className,
}: {
  type: VizservePmsInternalRequestType;
  className?: string;
}) {
  return <Pill tone="neutral" label={INTERNAL_REQUEST_LABELS[type]} className={className} />;
}

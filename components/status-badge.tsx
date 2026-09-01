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
import { internalRequestLabel } from "@/lib/schemas/internal-requests";
import {
  TASK_CATEGORY_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type TaskCategory,
  type TaskPriority,
} from "@/lib/schemas/tasks";

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
export type ChipTone = Tone;

/**
 * P7-61 — THE SAME TONE, AS A CONTROL RATHER THAN AS A LABEL.
 *
 * A chip says where something IS; a button says what pressing it DOES. Client
 * work now draws its one or two legal moves as buttons (`task-actions.tsx`),
 * and each needs to be the colour of what it means — otherwise "Pass QA" and
 * "Send back to PIC" are two identical rectangles side by side, which is the
 * confusion the dropdown had and the buttons were meant to end.
 *
 * ⚠️ THIS FILE STAYS THE ONE PLACE A TONE BECOMES A COLOUR (§4.1). The map is
 * tone → the button variant that wears it, not tone → a class string: the
 * colours themselves live in `buttonVariants`, next to the six other variants,
 * so a call site never writes a fill. `brand` is the exception and deliberately
 * so — a forward move is the page's PRIMARY action, and primary is a solid
 * brand fill rather than a brand tint.
 */
const TONE_BUTTON = {
  neutral: "outline",
  brand: "default",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
} as const;

export function toneButtonVariant(tone: Tone): (typeof TONE_BUTTON)[Tone] {
  return TONE_BUTTON[tone];
}

/**
 * The chip shape, for a labelled state that is NOT one of the canonical enums —
 * the landing page's module build status ("Live" / "Phase 5") and its approval
 * gate markers.
 *
 * Exported so those call sites stop hand-rolling their own. There were three
 * before: a `rounded-full bg-success-subtle` roadmap pill, a `rounded-full
 * bg-muted` one beside it, and a `rounded-full bg-brand` gate marker — each a
 * slightly different height and radius from the chips in the product, on the
 * one page a new hire sees first.
 *
 * A DATABASE status must still go through the typed badges below, which own the
 * status→tone maps. This is for the labels that have no enum behind them.
 */
export function Chip(props: { tone: Tone; label: string; icon?: LucideIcon; className?: string }) {
  return <Pill {...props} />;
}

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
  const config = REQUEST_STATUS[status] ?? {
    label: status,
    tone: "neutral" as const,
  };

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
 * The wash is the same tone the pill uses, thinned so a card still reads as
 * raised against it. It is a class string rather than a colour so the mapping
 * stays in this file, which is the only place a status is allowed to become a
 * colour (§4.1).
 *
 * TWO ALPHAS, and the second one is not a taste call. The dark `-subtle` fills
 * sit at almost exactly `--card`'s luminance, so a 45% wash in dark measured
 * 1.00–1.04:1 against a card laid on it — the cards and their column collapsed
 * into one field, held apart by a hairline alone. At 20% the column reads as a
 * HUE rather than as a lightness step and the card contrast comes back to
 * 1.04–1.06:1, level with the plain `bg-muted` column this replaced (1.08:1).
 * Light needs no such care: white on a 45% wash is 1.09–1.11:1, which is what
 * the old column measured too.
 *
 * Borders are full strength, not thinned. At 1.34–1.44:1 (light) and
 * 1.46–1.83:1 (dark) against the page they are a firmer edge than the default
 * `--border` hairline (1.16 / 1.30) — right for a column, which is a container
 * rather than a rule between rows.
 *
 * `--muted-foreground` holds 4.55–4.82:1 on every one of these in light and
 * 5.9–6.2:1 in dark, so the count beside the chip stays body-legal.
 *
 * Never the sole carrier of anything: the column is headed by a full chip with
 * its own icon and label, and this only tells the eye where one column stops.
 */
const TONE_SURFACE: Record<Tone, string> = {
  neutral: "border-border bg-muted",
  brand: "border-accent-border bg-accent/60 dark:bg-accent/30",
  info: "border-info-border bg-info-subtle/45 dark:bg-info-subtle/20",
  success: "border-success-border bg-success-subtle/45 dark:bg-success-subtle/20",
  warning: "border-warning-border bg-warning-subtle/45 dark:bg-warning-subtle/20",
  danger: "border-destructive-border bg-destructive-subtle/45 dark:bg-destructive-subtle/20",
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

/**
 * The stage as a single glyph, for a LIST ROW.
 *
 * ⚠️ THE LIST HAD NO STAGE INDICATOR AT ALL. The row's only status control is
 * `TaskStatusSelect variant="compact"`, which renders `ArrowRightLeft` — the
 * same "move" glyph for every stage, hidden until hover, and `null` outright
 * when there is nowhere legal to move to. So a row at rest said nothing about
 * where it was.
 *
 * That was defensible while the group heading directly above every row said it.
 * It stopped being true when P7-09 nested subtasks under their PARENT: a
 * subtask sits in its parent's group whatever its own status, so the heading
 * now describes the parent and not the row.
 *
 * NOT A CONTROL, and deliberately separate from `TaskStatusSelect`. This says
 * where the task is; that one moves it. Merging them would put a dead control on
 * every row that has nowhere to go — which is the trap the compact variant
 * already fell into by rendering nothing.
 *
 * The label rides `title` AND an `sr-only` span: state is never carried by
 * colour alone (§5.5), and a tooltip is not readable by a screen reader.
 */
export function TaskStatusGlyph({
  status,
  className,
}: {
  status: VizservePmsTaskStatus;
  className?: string;
}) {
  const tone = TASK_STATUS_TONES[status] ?? "neutral";
  const label = TASK_STATUS_LABELS[status] ?? status;
  const Icon = TASK_STATUS_ICONS[status];

  return (
    <span
      title={label}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full border",
        // The same tone map every other status in the app reads from, so a row
        // glyph and its column heading cannot drift into disagreeing about what
        // colour "For QA" is.
        TONE[tone],
        className,
      )}>
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export const TASK_STATUS_OPTIONS = (Object.keys(TASK_STATUS_TONES) as VizservePmsTaskStatus[]).map(
  (value) => ({ value, label: TASK_STATUS_LABELS[value] }),
);

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
const INTERNAL_STATUS: Record<VizservePmsInternalRequestStatus, { label: string; tone: Tone }> = {
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
  const config = INTERNAL_STATUS[status] ?? {
    label: status,
    tone: "neutral" as const,
  };

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
  // `internalRequestLabel` rather than a bare lookup: the database enum is
  // edited by hand in the SQL editor, so it can hold a value this build has
  // never heard of — and a bare lookup renders that as an EMPTY pill.
  return <Pill tone="neutral" label={internalRequestLabel(type)} className={className} />;
}

/**
 * P7-11 — priority.
 *
 * THE REFERENCE UI BREAKS THIS APP'S RULE and is not followed. ClickUp's picker
 * is four flags distinguished only by colour: identical shapes, red / yellow /
 * blue / grey. State is never conveyed by colour alone here, so priority gets
 * the same labelled chip every other status uses, and the flag is decoration
 * inside the picker rather than the carrier of the value anywhere else.
 *
 * `null` renders NOTHING, deliberately. Most tasks have no priority — that is
 * the ordinary state, not a missing value — and a "None" chip on every
 * unranked row would put a mark on everything, which is how a mark stops
 * meaning anything.
 */
const TASK_PRIORITY_TONES: Record<TaskPriority, ChipTone> = {
  URGENT: "danger",
  HIGH: "warning",
  NORMAL: "info",
  LOW: "neutral",
};

export function TaskPriorityBadge({
  priority,
  className,
}: {
  priority: TaskPriority | null;
  className?: string;
}) {
  if (!priority) return null;

  return (
    <Pill
      tone={TASK_PRIORITY_TONES[priority]}
      label={TASK_PRIORITY_LABELS[priority]}
      className={className}
    />
  );
}

// ---------------------------------------------------------------------------
// P7-27 — client work vs internal work, said loudly
// ---------------------------------------------------------------------------

/**
 * WHY THIS IS A CHIP AND NOT A WORD.
 *
 * The three categories were rendered as a plain `<span>` in a row of plain
 * `<span>`s — list name, category, subtask marker — all the same muted grey. So
 * the single most consequential fact about a task, the one that decides whether
 * finishing it needs a client's sign-off or just your own, read as the least
 * consequential thing on the row. On the board it was not rendered at all.
 *
 * `taskCategory` already answers the question; this is only about making the
 * answer visible at a glance.
 *
 * TONES, and the asymmetry is the point:
 *
 *   request   `brand`   — somebody outside the company is waiting on this, and
 *                         it cannot be finished without them. It is the only
 *                         one that earns an accent.
 *   internal  `neutral` — ordinary shared work.
 *   personal  `neutral` — your own list. Neutral like internal because the
 *                         difference between them is who may close it, not how
 *                         much it matters, and two accents would leave nothing
 *                         standing out.
 *
 * Never colour alone: `Pill` carries the label and a dot that inherits
 * `currentColor`, so the distinction survives greyscale exactly as every other
 * chip in this app does.
 */
const TASK_CATEGORY_TONES: Record<TaskCategory, Tone> = {
  request: "brand",
  internal: "neutral",
  personal: "neutral",
};

/**
 * CLIENT WORK IS THE ONE SOLID CHIP IN THE TASK VIEWS.
 *
 * Every other chip on a row — status, priority, category — is a subtle tint on
 * a pale ground, which is right for things you read once you are already
 * looking at the row. This one has to be answerable from across the screen,
 * because "does finishing this need somebody outside the company" changes what
 * the row means rather than decorating it.
 *
 * Solid `primary` is used by nothing else in the list or the board, so it
 * cannot be confused with a status or a priority. The label still says "Client"
 * — the fill is the second carrier, never the only one.
 */
const CLIENT_FILL = "border-primary bg-primary text-primary-foreground";

export function TaskCategoryBadge({
  category,
  className,
}: {
  category: TaskCategory;
  className?: string;
}) {
  return (
    <Pill
      tone={TASK_CATEGORY_TONES[category]}
      label={TASK_CATEGORY_LABELS[category]}
      className={cn(category === "request" && CLIENT_FILL, className)}
    />
  );
}

/**
 * The left edge of a row or card, accented for client work.
 *
 * A chip is readable once you are looking at a row. This is what makes a
 * COLUMN of rows scannable — client work has a coloured edge, everything else
 * does not, so "which of these has somebody outside waiting on it" is
 * answerable without reading a word.
 *
 * Returns the empty string for internal and personal deliberately, rather than
 * a neutral border: an accent that appears on every row is not an accent.
 */
export function taskCategoryEdge(category: TaskCategory): string {
  return category === "request" ? "border-l-2 border-l-accent-border" : "";
}

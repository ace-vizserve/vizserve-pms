import type { LucideIcon } from "lucide-react";
import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleCheckBig,
  CircleSlash,
  CircleX,
  ClipboardCheck,
  ScanSearch,
  SendHorizontal,
  Undo2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  VizservePmsInternalRequestStatus,
  VizservePmsInternalRequestType,
  VizservePmsRequestStatus,
  VizservePmsTaskStatus,
  VizservePmsTimesheetWeekStatus,
} from "@/lib/database.types";
import { APPROVAL_DECISION_LABELS, type ApprovalDecision } from "@/lib/schemas/approvals";
import { internalRequestLabel } from "@/lib/schemas/internal-requests";
import { TIMESHEET_WEEK_LABELS } from "@/lib/schemas/timesheet";
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
  /*
   * P11-14 — the four stage families (`--stage-*` in globals.css).
   *
   * ⚠️ THEY ARE NOT SEMANTIC AND MUST NOT BE REACHED FOR AS IF THEY WERE. The
   * six above mean something anywhere in the app — success is approved, danger
   * is rejected. These four mean a POSITION IN THE TASK PIPELINE and nothing
   * else, which is why they are named for the stage rather than the hue. A
   * leave request is never `client`; it has no client gate to be at.
   */
  qa: "border-stage-qa-border bg-stage-qa-subtle text-stage-qa",
  qaDeep: "border-stage-qa-deep-border bg-stage-qa-deep-subtle text-stage-qa-deep",
  client: "border-stage-client-border bg-stage-client-subtle text-stage-client",
  lapsed: "border-stage-lapsed-border bg-stage-lapsed-subtle text-stage-lapsed",
} as const;

type Tone = keyof typeof TONE;

/**
 * P11-15 — THE SAME TONE AS A SOLID, FOR A CHIP THAT IS A HEADING.
 *
 * A chip on a row is a note: it sits among other notes and a tint is right for
 * it. A chip that HEADS a group is a title, and the reference UI draws it as a
 * solid block of the stage's colour — which is the one thing that still read as
 * pale after the heading fill, the spine, the glyph ring and the row wash had
 * all been strengthened.
 *
 * ⚠️ HEADINGS ONLY, AND THAT BOUNDARY IS LOAD-BEARING. `TaskCategoryBadge`
 * spends a solid `--primary` to say "this needs a client", and it works because
 * it is the only solid chip on a row. Solid stage chips appear in group and
 * board-column headings, where no category chip is ever rendered, so a ROW
 * still carries exactly one solid and it still means client work. Passing
 * `solid` to a chip inside a row would spend that distinction.
 *
 * INK IS `text-background`, the page colour, which inverts with the theme —
 * #F5F7FA on the light solids (4.95–9.28:1) and #12151C on the dark ones
 * (5.21–8.43:1). One class, both themes, no per-tone foreground to keep in
 * step. `text-white` would have failed every dark solid.
 */
const TONE_SOLID: Record<Tone, string> = {
  neutral: "border-foreground-muted bg-foreground-muted",
  brand: "border-primary bg-primary",
  info: "border-info bg-info",
  success: "border-success bg-success",
  warning: "border-warning bg-warning",
  danger: "border-destructive bg-destructive",
  qa: "border-stage-qa bg-stage-qa",
  qaDeep: "border-stage-qa-deep bg-stage-qa-deep",
  client: "border-stage-client bg-stage-client",
  lapsed: "border-stage-lapsed bg-stage-lapsed",
};

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

/**
 * ⚠️ NARROWER THAN `Tone` SINCE P11-14, ON PURPOSE. The four stage tones have
 * no button variant and must never acquire one: a button says what pressing it
 * DOES, and "light violet" is where a task IS. Every caller feeds this
 * `transitionTone()`, which returns brand / success / info / warning — the
 * move's intent — so nothing is lost by refusing the rest at the type level.
 */
export type ButtonTone = keyof typeof TONE_BUTTON;

export function toneButtonVariant(tone: ButtonTone): (typeof TONE_BUTTON)[ButtonTone] {
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
  solid = false,
  className,
}: {
  tone: Tone;
  label: string;
  /** Solid fill with inverted ink. Headings only — see `TONE_SOLID`. */
  solid?: boolean;
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
    <span className={cn(PILL, solid ? cn(TONE_SOLID[tone], "text-background") : TONE[tone], className)}>
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
 * P7-63 — the Gate 1 outcome, as a chip rather than a capitalised enum.
 *
 * `app/(app)/requests/[id]/page.tsx` printed `{decision.decision}` in a
 * `font-medium capitalize` span, which meant an approval and a rejection were
 * the same sentence in the same colour — the one fact the card exists to report
 * was the one thing it did not say. It is a real Postgres enum
 * (`vizserve_pms_approval_decision`), so it belongs here with the other typed
 * badges rather than being toned at the call site (§4.1). `Chip` is for labels
 * with no enum behind them; this has one.
 *
 * EACH DECISION CARRIES ITS OWN GLYPH, not the shared dot. Three chips that
 * differ only by fill are three chips a greyscale screenshot cannot tell apart,
 * and this is the chip somebody scans a closed request for.
 */
const APPROVAL_DECISION_TONES: Record<ApprovalDecision, Tone> = {
  approved: "success",
  // Warning, not danger: a return is a negotiation with something to do next,
  // and the request is still alive. Rejection is the one that ends it.
  returned: "warning",
  rejected: "danger",
};

const APPROVAL_DECISION_ICONS: Record<ApprovalDecision, LucideIcon> = {
  approved: CircleCheck,
  returned: Undo2,
  rejected: CircleX,
};

export function ApprovalDecisionBadge({
  decision,
  className,
}: {
  decision: ApprovalDecision;
  className?: string;
}) {
  return (
    <Pill
      tone={APPROVAL_DECISION_TONES[decision] ?? "neutral"}
      label={APPROVAL_DECISION_LABELS[decision] ?? decision}
      icon={APPROVAL_DECISION_ICONS[decision]}
      className={className}
    />
  );
}

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
  /*
   * P11-14 — EIGHT STAGES, EIGHT COLOURS. Before this, FOR_QA and
   * QA_IN_PROGRESS both took the brand tint that ONGOING already had, and
   * FOR_CLIENT_APPROVAL took the amber WAITING_FOR_INFO had, and
   * COMPLETED_NO_RESPONSE took the grey OPEN had. Five stages, three colours:
   * once the whole row is washed in its stage's tone, two groups that share a
   * colour are two groups nobody can tell apart at a glance.
   *
   * The two QA stages read as one family at two depths because that is what
   * they are — queued for checking, then being checked. The client gate gets
   * the one hue that belongs to nothing else in the app, because it is the one
   * stage where the task has left the building.
   */
  FOR_QA: "qa",
  QA_IN_PROGRESS: "qaDeep",
  FOR_CLIENT_APPROVAL: "client",
  COMPLETED: "success",
  /*
   * ⚠️ SAGE, AND IT IS A WEAKER SIGNAL THAN THE GREY IT REPLACED. Asked for as
   * "pale green" alongside COMPLETED's green. As row washes the two sit 1.02:1
   * apart, which is no lightness difference at all — where grey vs green was
   * unmissable. The split is what Phase 6 reports on, so what actually keeps it
   * readable is the pair this file already gives them: distinct labels
   * ("Completed" / "Completed (no response)") and distinct glyphs
   * (`CircleCheckBig` / `CircleSlash`). Both must stay.
   */
  COMPLETED_NO_RESPONSE: "lapsed",
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
  qa: "border-stage-qa-border bg-stage-qa-subtle/45 dark:bg-stage-qa-subtle/20",
  qaDeep: "border-stage-qa-deep-border bg-stage-qa-deep-subtle/45 dark:bg-stage-qa-deep-subtle/20",
  client: "border-stage-client-border bg-stage-client-subtle/45 dark:bg-stage-client-subtle/20",
  lapsed: "border-stage-lapsed-border bg-stage-lapsed-subtle/45 dark:bg-stage-lapsed-subtle/20",
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

/**
 * A status as a GROUP HEADING — the bar at the top of a list group.
 *
 * ⚠️ NOT `taskStatusSurface`, AND THE DIFFERENCE IS WHAT SITS ON TOP. The board
 * column wash is thinned to 45%/20% because white cards are laid on it and have
 * to keep reading as raised. A list heading is a bare 36px bar with nothing on
 * it but a chip and a count, so the same thinning bought nothing and cost
 * everything: 60% of `--accent` over a white card is #F2F4FA, and a stack of
 * groups headed Open / Ongoing / Completed came out three shades of white. The
 * one job of the heading — say which stage this block of rows is — was being
 * done by the chip alone.
 *
 * So the fill is the tone's `-subtle` at FULL strength here. Measured on the
 * light fills: `--foreground-muted` 5.52–5.70:1, `--foreground` 15.7–16.2:1; on
 * the dark fills 5.97–6.62:1 and 13.1–14.6:1. All body-legal, which the 45%
 * wash was not quite — `--muted-foreground` landed at 4.41–4.46:1 on the
 * strengthened fills, which is why the count beside the chip moved to
 * `--foreground-muted`.
 *
 * ⚠️ THE FILLS ARE STILL PALE, AND THAT IS THE CEILING. `--success-subtle` is
 * #E8F3EE; nothing about full strength makes it green enough to find from
 * across a screen. That is what `taskStatusEdge` is for — the spine carries the
 * colour, this carries the tint, and neither carries the meaning, which is the
 * chip's job (§5.5).
 */
const TONE_HEADING: Record<Tone, string> = {
  qa: "border-stage-qa-border bg-stage-qa-subtle",
  qaDeep: "border-stage-qa-deep-border bg-stage-qa-deep-subtle",
  client: "border-stage-client-border bg-stage-client-subtle",
  lapsed: "border-stage-lapsed-border bg-stage-lapsed-subtle",
  neutral: "border-border bg-muted",
  brand: "border-accent-border bg-accent",
  info: "border-info-border bg-info-subtle",
  success: "border-success-border bg-success-subtle",
  warning: "border-warning-border bg-warning-subtle",
  danger: "border-destructive-border bg-destructive-subtle",
};

export function taskStatusHeading(status: VizservePmsTaskStatus): string {
  return TONE_HEADING[TASK_STATUS_TONES[status] ?? "neutral"];
}

/**
 * The stage as a SOLID SPINE down the left edge of its group panel.
 *
 * This is the part that is actually answerable at a glance. A tint on a heading
 * bar is legible once you are looking at it; 4px of `--success` running the
 * height of the panel is what makes "where does Completed start" answerable
 * while scrolling. Against a white card the solids measure 5.21–6.54:1 and in
 * dark 5.55–7.87:1 — far past the 3:1 a non-text boundary owes.
 *
 * NEUTRAL TAKES `--foreground-faint` (3.44:1 light, 3.82:1 dark) RATHER THAN A
 * SEMANTIC SOLID, and both halves of that matter. Open is the quiet stage and
 * should read quieter than the coloured ones, so it gets grey — and
 * `--foreground-faint` exists precisely so the tertiary grey is reachable for
 * decoration without being reachable for text (§1.1). A spine is decoration:
 * the chip beside it says "Open" in words.
 *
 * Never the sole carrier of state — same rule as every other colour in this
 * file. Greyscale the screen and the six spines collapse to two or three
 * lightnesses; the labelled chip is what survives that, and it always renders.
 */
/**
 * ⚠️ ONE MAP, TWO SPELLINGS, BECAUSE TAILWIND CANNOT SHARE THEM. `border-l-success`
 * sets `border-left-color` and `border-success` sets all four; there is no class
 * that is both, and a dynamic `border-l-${tone}` is never generated. Holding the
 * pair in one entry is what stops these becoming two maps that drift — this repo
 * has lost five tone maps to exactly that.
 *
 * `spine` is the group panel's left edge, `ring` the row glyph's outline, and
 * `rule` the line under a group heading. All one colour on purpose: a row's
 * glyph, the heading above it and the panel around them must not disagree about
 * what Ongoing looks like.
 */
const TONE_EDGE: Record<Tone, { spine: string; ring: string; rule: string }> = {
  qa: { spine: "border-l-stage-qa", ring: "border-stage-qa", rule: "border-b-stage-qa" },
  qaDeep: {
    spine: "border-l-stage-qa-deep",
    ring: "border-stage-qa-deep",
    rule: "border-b-stage-qa-deep",
  },
  client: {
    spine: "border-l-stage-client",
    ring: "border-stage-client",
    rule: "border-b-stage-client",
  },
  lapsed: {
    spine: "border-l-stage-lapsed",
    ring: "border-stage-lapsed",
    rule: "border-b-stage-lapsed",
  },
  neutral: {
    spine: "border-l-foreground-faint",
    ring: "border-foreground-faint",
    rule: "border-b-foreground-faint",
  },
  brand: { spine: "border-l-primary", ring: "border-primary", rule: "border-b-primary" },
  info: { spine: "border-l-info", ring: "border-info", rule: "border-b-info" },
  success: { spine: "border-l-success", ring: "border-success", rule: "border-b-success" },
  warning: { spine: "border-l-warning", ring: "border-warning", rule: "border-b-warning" },
  danger: {
    spine: "border-l-destructive",
    ring: "border-destructive",
    rule: "border-b-destructive",
  },
};

export function taskStatusEdge(status: VizservePmsTaskStatus): string {
  return TONE_EDGE[TASK_STATUS_TONES[status] ?? "neutral"].spine;
}

/**
 * The same solid, as the RING around a row's stage glyph.
 *
 * ⚠️ THE GLYPH ALREADY HAD ITS COLOUR AND IT STILL READ AS GREY MUSH. The icon
 * sits on the tone's `-subtle` fill at 4.57–5.74:1 light and 5.40–7.25:1 dark,
 * which is legible — but it was a 12px glyph inside a 20px disc whose outline
 * was the tone's `-border` hairline at **1.43–1.81:1 against the card**. At that
 * size the outline is most of the object, so the disc read as a faint grey
 * smudge on every row whatever its status. Swapping the hairline for the solid
 * takes the ring to the icon's own 4.57–5.74:1 and is what actually makes the
 * stage answerable while scanning a column of rows.
 *
 * STILL A TINT FILL, NOT A SOLID DISC. A solid brand fill is spoken for — it is
 * how `TaskCategoryBadge` says "this needs a client", and it is load-bearing
 * precisely because nothing else in the list or the board wears it. A solid
 * blue dot on every ongoing row would spend that.
 *
 * Neutral takes `--foreground-faint` for the reason `taskStatusEdge` gives:
 * Open is the quiet stage, and this is decoration beside a `title` and an
 * `sr-only` label that both say the word.
 */
export function taskStatusRing(status: VizservePmsTaskStatus): string {
  return TONE_EDGE[TASK_STATUS_TONES[status] ?? "neutral"].ring;
}

/**
 * The same solid again, as the RULE under a group heading.
 *
 * Needed once the rows below the heading took the same fill it has (see
 * `taskStatusRow`). Heading and body are one colour now, so the line between
 * them is the only thing left saying which is which — a `--border` hairline at
 * 1.16:1 could not do it, and there is no darker fill available that keeps its
 * text legal. The heading is told apart by its chip, its caps and this rule.
 */
export function taskStatusRule(status: VizservePmsTaskStatus): string {
  return TONE_EDGE[TASK_STATUS_TONES[status] ?? "neutral"].rule;
}

/**
 * A status as a TABLE ROW — the whole row washed in its stage's tone.
 *
 * ⚠️ THE THIRD ANSWER TO ONE COMPLAINT, AND THE FIRST TWO WERE BOTH TOO TIMID.
 * The heading went from a 45% wash to a full fill, and the row glyph from a
 * hairline ring to a solid one; the report back was still "I see white", and it
 * was correct — a 24px disc and a 36px bar are a rounding error against a 56px
 * row that runs the width of the screen. The row is the object; colour it.
 *
 * THE FILL IS THE TONE'S `-subtle` AT FULL STRENGTH, which is also what the
 * heading wears. They are deliberately the same: nothing stronger exists that
 * keeps its text legal — the tone's `-border` as a fill measures 3.39–4.43:1
 * for `--foreground-muted` and 2.79–3.53:1 for `--muted-foreground`, and it
 * flattens the heading's own chip to 1.29–1.35:1 against its ground, so the chip
 * stops reading as a raised object. That was measured and rejected;
 * `taskStatusRule` separates the two instead.
 *
 * HOVER IS `-border/60`, the one ground darker than the row that stays legal:
 * 1.10–1.26:1 against the row it lifts from, with `--foreground-muted` at
 * 4.52–5.12:1 light and 4.61–5.71:1 dark. `has-aria-expanded` takes the same
 * ground — a parent showing its subtasks is held open, which is hover that
 * stuck. Both restate the base row's grey `hover:bg-muted/50`, which would
 * otherwise drop the hue on the one row the pointer is on.
 *
 * ⚠️ THE LAST CLASS RE-POINTS `--muted-foreground` AND IS NOT A TRICK. On these
 * fills the tertiary grey measures 4.41–4.55:1 and misses 4.5:1 — and a task row
 * carries that token in nine places across five components (the meta line, the
 * subtask count, the list name, the cover dates, the estimate, the assignee
 * overflow). Re-pointing the variable on the row fixes every one of them by
 * inheritance, including the tenth that gets added next month. `@theme inline`
 * is what makes it work: `text-muted-foreground` compiles to
 * `color: var(--muted-foreground)`, so an override on the `<tr>` reaches all of
 * them. Chasing the call sites instead would fix today's nine and silently miss
 * the next one.
 */
const TONE_ROW: Record<Tone, string> = {
  qa: "bg-stage-qa-subtle hover:bg-stage-qa-border/60 has-aria-expanded:bg-stage-qa-border/60",
  qaDeep:
    "bg-stage-qa-deep-subtle hover:bg-stage-qa-deep-border/60 has-aria-expanded:bg-stage-qa-deep-border/60",
  client:
    "bg-stage-client-subtle hover:bg-stage-client-border/60 has-aria-expanded:bg-stage-client-border/60",
  lapsed:
    "bg-stage-lapsed-subtle hover:bg-stage-lapsed-border/60 has-aria-expanded:bg-stage-lapsed-border/60",
  neutral: "bg-muted hover:bg-border-strong/60 has-aria-expanded:bg-border-strong/60",
  brand: "bg-accent hover:bg-accent-border/60 has-aria-expanded:bg-accent-border/60",
  info: "bg-info-subtle hover:bg-info-border/60 has-aria-expanded:bg-info-border/60",
  success: "bg-success-subtle hover:bg-success-border/60 has-aria-expanded:bg-success-border/60",
  warning: "bg-warning-subtle hover:bg-warning-border/60 has-aria-expanded:bg-warning-border/60",
  danger:
    "bg-destructive-subtle hover:bg-destructive-border/60 has-aria-expanded:bg-destructive-border/60",
};

export function taskStatusRow(status: VizservePmsTaskStatus): string {
  return cn(
    TONE_ROW[TASK_STATUS_TONES[status] ?? "neutral"],
    "[--muted-foreground:var(--foreground-muted)]",
  );
}

export function TaskStatusBadge({
  status,
  icon = false,
  solid = false,
  className,
}: {
  status: VizservePmsTaskStatus;
  /** Swap the dot for the stage's glyph. Board column headings; not table cells. */
  icon?: boolean;
  /**
   * Solid fill in the stage's colour. For the chip that HEADS a group or a
   * board column — never for one sitting on a row, which would spend the solid
   * fill that `TaskCategoryBadge` relies on. See `TONE_SOLID`.
   */
  solid?: boolean;
  className?: string;
}) {
  return (
    <Pill
      tone={TASK_STATUS_TONES[status] ?? "neutral"}
      label={TASK_STATUS_LABELS[status] ?? status}
      icon={icon ? TASK_STATUS_ICONS[status] : undefined}
      solid={solid}
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
 * NOT A CONTROL ITSELF, but since P12-18 it is what the list row's control is
 * made of: `TaskStatusSelect variant="glyph"` renders this INSIDE its trigger,
 * so the badge you read is the button you press and the row no longer carries a
 * second, different icon at the other end of the cell for moving the task.
 *
 * ⚠️ THE OLD WARNING HERE STILL STANDS AND IS WHY THAT VARIANT EXISTS RATHER
 * THAN A `onClick` ON THIS COMPONENT. "Merging them would put a dead control on
 * every row that has nowhere to go" — so the decision about whether there IS a
 * control belongs to the thing that knows the legal moves. With none, that
 * variant renders this component bare, exactly as every other caller does.
 *
 * The label rides `title` AND an `sr-only` span: state is never carried by
 * colour alone (§5.5), and a tooltip is not readable by a screen reader.
 */
export function TaskStatusGlyph({
  status,
  className,
  decorative = false,
}: {
  status: VizservePmsTaskStatus;
  className?: string;
  /**
   * Drop the `title` and the `sr-only` label, for a caller that already carries
   * both — today that is `TaskStatusSelect variant="glyph"`, whose trigger is
   * named "Status: For QA. Change it." and has a tooltip of its own. Without
   * this the status is announced twice and two tooltips overlap on one 24px
   * target.
   *
   * ⚠️ IT IS NOT A STYLE FLAG. Set it only where the accessible name is
   * genuinely supplied by an ancestor, or the row goes back to conveying its
   * state by colour and shape alone.
   */
  decorative?: boolean;
}) {
  const tone = TASK_STATUS_TONES[status] ?? "neutral";
  const label = TASK_STATUS_LABELS[status] ?? status;
  const Icon = TASK_STATUS_ICONS[status];

  return (
    <span
      title={decorative ? undefined : label}
      className={cn(
        // 24px, up from 20. The glyph is the only thing on a row that says where
        // the task is, and at 20px with a 12px icon there was not enough of it
        // for a colour to land — it also now clears the 24px target floor (§5.8)
        // should it ever gain a click.
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full border",
        // The same tone map every other status in the app reads from, so a row
        // glyph and its column heading cannot drift into disagreeing about what
        // colour "For QA" is. Supplies the subtle fill and the solid icon.
        TONE[tone],
        // ⚠️ AFTER `TONE`, AND THE ORDER IS THE POINT. Both set a border colour,
        // `cn` is tailwind-merge, and last wins — so this replaces the tone's
        // `-border` hairline rather than fighting it.
        taskStatusRing(status),
        className,
      )}>
      <Icon className="size-3.5" aria-hidden />
      {decorative ? null : <span className="sr-only">{label}</span>}
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
  /**
   * P9-02. NEUTRAL, not danger — the request did not fail, its author took it
   * back before anybody had answered. Colouring it like a rejection would say
   * the opposite of what happened to the one person most likely to be looking
   * at it, and this is precisely the distinction the status exists to draw.
   */
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
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
 * A handed-in timesheet week (P7-05).
 *
 * ⚠️ A THIRD VOCABULARY, AND IT IS NOT THE INTERNAL-REQUEST ONE. A week is
 * SUBMITTED / RETURNED / APPROVED and can never be REJECTED — D23: hours already
 * worked cannot be un-worked, so a lead either accepts them or sends them back
 * to be fixed. An internal request takes the opposite subset: it can be REJECTED
 * and can never be RETURNED. Folding the two maps together would put a label on
 * each set for a state it cannot reach.
 *
 * `TIMESHEET_WEEK_LABELS` stays the source of the wording — it is the schema's
 * half of the contract and the timesheet screens already read it. Only the
 * status→tone map is new here, which is what this file owns.
 */
const TIMESHEET_WEEK_TONES: Record<VizservePmsTimesheetWeekStatus, Tone> = {
  SUBMITTED: "info",
  RETURNED: "warning",
  APPROVED: "success",
};

export function TimesheetWeekBadge({
  status,
  className,
}: {
  status: VizservePmsTimesheetWeekStatus;
  className?: string;
}) {
  return (
    <Pill
      tone={TIMESHEET_WEEK_TONES[status] ?? "neutral"}
      label={TIMESHEET_WEEK_LABELS[status] ?? status}
      className={className}
    />
  );
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
 * Solid `primary` is used by nothing else ON A ROW, so it cannot be confused
 * with a status or a priority. The label still says "Client" — the fill is the
 * second carrier, never the only one.
 *
 * ⚠️ P11-15 NARROWED THAT SENTENCE FROM "in the list or the board" TO "on a
 * row", and the boundary is now the thing holding it up. Group and board-column
 * HEADINGS draw their status chip solid (`TONE_SOLID`). No category chip is
 * ever rendered in a heading, so a row still carries exactly one solid fill and
 * it still means client work — but only for as long as `solid` stays out of
 * the row cells.
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

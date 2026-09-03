import type { ChipTone } from "@/components/status-badge";

/**
 * Presentation for the audit trail (P0-09).
 *
 * The table has existed since Phase 0 and every mutation in the app writes to
 * it, but nothing has ever READ it — the RLS policy is admin-only select and
 * there was no screen behind it. This module is what `/admin/audit` needs to
 * turn a row into something an admin can scan.
 *
 * `entity_type` and `action` are FREE TEXT in Postgres, deliberately: the write
 * helper is called from server actions and from a dozen SQL functions, several
 * of which pass `lower(v_status::text)` so the action is whatever the status
 * machine just produced. That means this file must LABEL what it knows and fall
 * back gracefully for what it does not — a new action string appearing in a
 * migration must never render as a blank cell or throw.
 */

/**
 * The entity types written today, in the order the filter lists them.
 *
 * Not an enum mirror — there is no enum. This is the list as of the audit
 * screen landing, gathered from every `vizserve_pms_write_audit_log` call site
 * in `app/` and `supabase/migrations/`. A row whose type is not here still
 * renders; it just shows the raw key, which is the signal to add it.
 */
export const AUDIT_ENTITY_TYPES = [
  "user",
  "request",
  "internal_request",
  "task",
  "dtr_entry",
  "timesheet_week",
  "holiday",
  "event",
  "app_settings",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Reader-facing labels. "Client request" and "Internal request" are spelled out
 * rather than left as "Request" and "Internal request", because the two are
 * separate tables with separate lifecycles (CLAUDE.md, "Architecture in one
 * pass") and an admin reading a trail needs to know which one moved.
 */
export const AUDIT_ENTITY_LABELS: Record<AuditEntityType, string> = {
  user: "User account",
  request: "Client request",
  internal_request: "Internal request",
  task: "Task",
  dtr_entry: "DTR entry",
  timesheet_week: "Timesheet week",
  holiday: "Holiday",
  event: "Event",
  app_settings: "Settings",
};

/**
 * Narrows an untrusted `?entity=` value.
 *
 * Less load-bearing than the notification guard — `entity_type` is text, so an
 * unknown value is a filter that matches nothing rather than a Postgres error.
 * It is still checked, so a hand-edited URL renders "no results for that
 * filter" instead of an empty table with a dropdown showing a raw string.
 */
export function isAuditEntityType(value: unknown): value is AuditEntityType {
  return typeof value === "string" && (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** The label for a type, falling back to the raw key for one not listed above. */
export function auditEntityLabel(entityType: string): string {
  return isAuditEntityType(entityType) ? AUDIT_ENTITY_LABELS[entityType] : entityType;
}

/**
 * Where a record lives, so the Record column is a link and not a dead label.
 *
 * Only the types with a real detail route are here. The rest return null and
 * render as plain text — a link to a page that does not exist is worse than no
 * link, and this map is the one place to extend when a route lands.
 *
 * Deliberately NOT a link for `user`, `holiday`, `event` or `app_settings`:
 * those admin screens are lists with no per-row route, so the link would put
 * the reader on a page and leave them to find the row themselves.
 */
export function auditEntityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "task":
      return `/tasks/${entityId}`;
    case "request":
      return `/requests/${entityId}`;
    case "internal_request":
      return `/approvals/${entityId}`;
    default:
      return null;
  }
}

/**
 * Actions whose wording is worth pinning.
 *
 * Everything else falls through to `auditActionLabel`'s de-snake-casing, which
 * is right for the long tail — `status_overridden` reads fine as "Status
 * overridden" and does not need an entry here. What DOES need one is anything
 * the humanised string would get wrong: `punch_in` would otherwise read "Punch
 * in" as an instruction rather than a thing that happened.
 */
const ACTION_LABELS: Record<string, string> = {
  punch_in: "Timed in",
  punch_out: "Timed out",
  leave_allocation_set: "Leave allocation set",
  // "Temporary password set" is what the de-snake-caser produces anyway; pinned
  // because the wording is the whole meaning here. "Password set" would read as
  // an owner choosing somebody's permanent password, which is precisely what
  // this is not.
  temporary_password_set: "Temporary password issued",
  password_changed: "Password changed by the account holder",
  auto_completed: "Auto-completed",
  completed_no_response: "Closed — no client response",
};

/**
 * Tone per action.
 *
 * Colour is a SECOND carrier here, never the only one: the chip always shows
 * the action's words, so a greyscale screenshot of this trail still reads. The
 * tones exist so a page of forty rows lets the destructive ones (deleted,
 * rejected, deactivated) surface without being hunted for.
 */
const ACTION_TONES: Record<string, ChipTone> = {
  created: "success",
  approved: "success",
  completed: "success",
  submitted: "neutral",
  updated: "brand",
  edited: "brand",
  renamed: "brand",
  corrected: "brand",
  status_overridden: "brand",
  pending_review: "warning",
  // P8-11. Not destructive and not routine. An owner issuing a colleague a
  // TEMPORARY PASSWORD is the action people come to this screen to check on —
  // more so than the reset link it replaced, because for a short window two
  // people know one credential. It must not sit at the same weight as an
  // "updated".
  temporary_password_set: "warning",
  // The other half of the same story, and deliberately NOT a warning: this is
  // the person closing the window above, which is the outcome the flag exists
  // to produce. A trail where the fix reads as alarming as the risk teaches
  // people to ignore both.
  password_changed: "success",
  returned: "info",
  // Both spellings are live in the database — `returned` from the request gates
  // and `revision_requested` from QA. Same meaning to a reader, so same tone.
  revision_requested: "info",
  auto_completed: "info",
  completed_no_response: "info",
  punch_in: "info",
  punch_out: "info",
  deleted: "danger",
  rejected: "danger",
  deactivated: "danger",
};

/** "status_overridden" to "Status overridden". Pinned wording wins. */
export function auditActionLabel(action: string): string {
  const pinned = ACTION_LABELS[action];
  if (pinned) return pinned;

  const words = action.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

export function auditActionTone(action: string): ChipTone {
  return ACTION_TONES[action] ?? "neutral";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "created_at" to "Created at". Field keys come straight from the payload. */
export function formatAuditKey(key: string): string {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * uuid → the name of the thing it points at.
 *
 * Built on the server from the tables whose ids actually appear inside audit
 * payloads: users (`actor_id`, `assignee_id`, `qa_assignee_id`), leave types
 * (the KEYS of the leave allocation map) and departments. Passed in rather than
 * looked up here so this module stays free of a database client, and so the
 * page fetches each table once for a whole page of rows instead of once a row.
 */
export type AuditLookup = Record<string, string>;

/**
 * An id we could not name, shortened.
 *
 * A judgement call against the house rule that a UUID never reaches a user
 * (docs/12 §6). The rule holds for product screens; this is the audit trail,
 * and an admin correlating two entries has nothing else to go on when the id
 * belongs to a table the lookup does not cover. The compromise is that the long
 * form never appears in a cell — the full id is on the dialog's footer line,
 * once, where it can be copied.
 */
function shortId(value: string): string {
  return `${value.slice(0, 8)}…`;
}

/** A payload key, as a heading. Resolves an id-shaped key to what it names. */
function labelForSegment(segment: string, lookup: AuditLookup): string {
  if (isUuid(segment)) return lookup[segment] ?? shortId(segment);
  return formatAuditKey(segment);
}

/**
 * A jsonb leaf as one line of text.
 *
 * An em-dash for absent, not "null" or an empty cell: "null" is a database word
 * on a screen that has no business showing one, and an empty cell is
 * indistinguishable from a rendering failure.
 *
 * An id-shaped string is resolved through the lookup, because a raw
 * `2105d7f9-366e-…` in an "Assignee" cell answers nobody's question. Arrays of
 * scalars are joined rather than stringified — `app_access` reads as
 * "pms, sis", and the brackets and quotes were never carrying meaning.
 */
export function formatAuditValue(value: unknown, lookup: AuditLookup = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return isUuid(value) ? (lookup[value] ?? shortId(value)) : value;

  if (Array.isArray(value)) {
    // Only a list of scalars flattens. An array of objects keeps its JSON,
    // which is ugly and honest — inventing a rendering for a shape nothing
    // writes yet would be a guess that silently drops fields.
    return value.every((item) => item === null || typeof item !== "object")
      ? value.map((item) => formatAuditValue(item, lookup)).join(", ")
      : JSON.stringify(value);
  }

  return JSON.stringify(value);
}

/**
 * One row of the detail table: a leaf value, both sides, already rendered.
 *
 * Formatted on the SERVER and handed to the dialog as strings. The alternative
 * — shipping the lookup to the client and formatting there — sends the same map
 * of names once per row in the flight payload, to do work that does not depend
 * on anything the browser knows.
 */
export type AuditField = {
  /** Dotted path, unique within the entry. The React key. */
  path: string;
  /** The leaf's own name, e.g. "Vacation Leave". */
  label: string;
  /** The path above it, e.g. "Allocations". Null at the top level. */
  group: string | null;
  before: string;
  after: string;
  changed: boolean;
};

/**
 * Absent and explicitly-null are the SAME to a reader.
 *
 * Without this, a payload carrying `"priority": null` against a `before` that
 * simply has no `priority` key compares as a change — `undefined` and `null`
 * stringify differently — and then renders "— → —": a row asserting that
 * nothing became nothing. Every `created` entry from
 * `vizserve_pms_create_manual_task` had one.
 */
function normalise(value: unknown): unknown {
  return value === undefined ? null : value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/**
 * How deep to expand before giving up and stringifying.
 *
 * Two levels covers everything written today (`{balance_year, allocations:{…}}`
 * is the deepest). The guard is here so a future payload with a nested tree
 * degrades to JSON in one cell rather than exploding into a hundred rows.
 */
const MAX_DEPTH = 3;

function walk(
  before: unknown,
  after: unknown,
  lookup: AuditLookup,
  path: string[],
  out: AuditField[],
): void {
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};

  // The UNION of both key sets, so a field present on only one side — a column
  // added since the row was written — still appears.
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    const next = [...path, key];

    // EXPANDED, not stringified. This is the whole fix for the leave
    // allocation entry: nine leave types in one `allocations` object used to
    // render as a 500-character line in both columns, identical apart from one
    // digit, under a heading that said "Changed".
    if ((isRecord(left) || isRecord(right)) && next.length < MAX_DEPTH) {
      walk(left, right, lookup, next, out);
      continue;
    }

    out.push({
      path: next.join("."),
      label: labelForSegment(key, lookup),
      group: path.length > 0 ? path.map((seg) => labelForSegment(seg, lookup)).join(" · ") : null,
      before: formatAuditValue(left, lookup),
      after: formatAuditValue(right, lookup),
      changed: !sameValue(left, right),
    });
  }
}

/**
 * A payload pair, flattened into rows a person can read.
 *
 * Sorted by label rather than left in payload order, because jsonb does not
 * preserve payload order — Postgres stores object keys sorted by length then
 * bytewise, so "insertion order" is already gone by the time it is read back.
 * Alphabetical is at least the same every time.
 */
export function auditFields(
  before: unknown,
  after: unknown,
  lookup: AuditLookup = {},
): AuditField[] {
  const fields: AuditField[] = [];
  walk(before, after, lookup, [], fields);

  return fields.sort((x, y) =>
    (x.group ?? "").localeCompare(y.group ?? "") || x.label.localeCompare(y.label),
  );
}

/**
 * How far back the list reaches. `all` is the absence of the param.
 *
 * A window rather than a pair of date pickers: this table only grows, and the
 * question an admin actually arrives with is "what happened recently", not
 * "what happened between two dates I will now type twice". The pickers can be
 * added the first time somebody needs them; three presets cover what we know
 * people arrive with.
 */
export const AUDIT_PERIODS = ["7", "30", "90", "all"] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

export const AUDIT_PERIOD_LABELS: Record<AuditPeriod, string> = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  all: "All time",
};

export function isAuditPeriod(value: unknown): value is AuditPeriod {
  return typeof value === "string" && (AUDIT_PERIODS as readonly string[]).includes(value);
}

/**
 * Matches a UUID, so a pasted id in the search box becomes an exact `entity_id`
 * lookup instead of an `ilike`.
 *
 * This is not a nicety: `entity_id` is a `uuid` column and Postgres has no
 * `uuid ~~ text` operator, so an ilike against it is a 400 the reader sees as
 * "search is broken". Routing a UUID to `.eq` and everything else to the text
 * columns is what lets one box answer both "show me this record's history" and
 * "show me every deletion".
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

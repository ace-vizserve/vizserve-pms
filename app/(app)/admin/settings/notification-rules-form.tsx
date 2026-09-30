"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";

import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import type { Role } from "@/lib/auth/roles";
import { relationshipLabel } from "@/lib/schemas/notification-rules";
import { ROLE_LABELS } from "@/lib/schemas/users";
import { cn } from "@/lib/utils";

import { addNotificationRule, removeNotificationRule, updateNotificationRule } from "./actions";
import { FlowDiagram } from "./flow-diagram";

export type NotificationEvent = {
  key: string;
  flow: string;
  flow_label: string;
  flow_sort: number;
  stage_label: string;
  sort: number;
  ends_flow: boolean;
  description: string;
  /** P14-12. Absent until that migration is applied — see `shapeOf`. */
  stage_kind?: "step" | "outcome" | "side" | "event";
  /** P14-12. The step a side event leaves from; null = at any step. */
  branch_from?: string | null;
  /** P14-12. Where the work goes next; null = the process ends. */
  returns_to?: string | null;
};

export type NotificationRule = {
  id: string;
  event_key: string;
  audience_kind: "relationship" | "role" | "user";
  audience: string | null;
  user_id: string | null;
  in_app: boolean;
  email: boolean;
  locked: boolean;
};

/** Roles an Admin can add as recipients, most senior first. */
const ADDABLE_ROLES: Role[] = ["owner", "business_manager", "admin", "manager", "team_leader"];

/** Recipient · In-app · Email · remove — shared by the header and every row so they line up. */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_2rem] items-center gap-x-3";

const KIND_ORDER = ["relationship", "role", "user"] as const;
const KIND_LABEL: Record<NotificationRule["audience_kind"], string> = {
  relationship: "Named by the process",
  role: "Role",
  user: "Person",
};

/** An outcome's chip: what the process ended as, in its own words. */
function outcomeTone(event: NotificationEvent): "success" | "danger" | "neutral" {
  if (/\.approved$/.test(event.key)) return "success";
  if (/\.rejected$/.test(event.key)) return "danger";
  return "neutral";
}

/**
 * Splits a process's stages into what the flow draws: numbered STEPS, the
 * OUTCOMES it ends in, and SIDE events on a branch. Driven by `stage_kind`
 * (P14-12); before that is applied, outcomes are the ending stages and
 * everything else is a step.
 */
function shapeOf(events: NotificationEvent[]) {
  const kind = (event: NotificationEvent) => event.stage_kind ?? (event.ends_flow ? "outcome" : "step");
  return {
    path: events.filter((event) => kind(event) === "step"),
    outcomes: events.filter((event) => kind(event) === "outcome"),
    along: events.filter((event) => kind(event) === "side" || kind(event) === "event"),
  };
}

/**
 * P14-09 — THE PROCESS, DRAWN AS A FLOW.
 *
 * Pick a process; its stages are drawn left to right as connected boxes —
 * numbered steps, then the outcomes it can end in — with side events (sent
 * back, cancelled…) on a branch underneath. Click a box and its notification
 * settings open below: who needs to act (fixed by the approval routing) and who
 * is also told (switchable; add a role or a person). Adding somebody never
 * changes who approves.
 */
export function NotificationRulesForm({
  events,
  rules,
  people,
}: {
  events: NotificationEvent[];
  rules: NotificationRule[];
  people: { id: string; full_name: string }[];
}) {
  const nameOf = useMemo(() => new Map(people.map((person) => [person.id, person.full_name])), [people]);

  const flows = useMemo(() => {
    const byFlow = new Map<string, { label: string; sort: number; events: NotificationEvent[] }>();
    for (const event of events) {
      const flow = byFlow.get(event.flow) ?? { label: event.flow_label, sort: event.flow_sort, events: [] };
      flow.events.push(event);
      byFlow.set(event.flow, flow);
    }
    return [...byFlow.entries()]
      .map(([key, flow]) => ({ key, ...flow, events: flow.events.sort((a, b) => a.sort - b.sort) }))
      .sort((a, b) => a.sort - b.sort);
  }, [events]);

  const [activeFlow, setActiveFlow] = useState(flows[0]?.key ?? "");
  const flow = flows.find((candidate) => candidate.key === activeFlow) ?? flows[0];
  const [selected, setSelected] = useState<string | null>(flow?.events[0]?.key ?? null);

  const shape = flow ? shapeOf(flow.events) : { path: [], outcomes: [], along: [] };
  const selectedEvent = flow?.events.find((event) => event.key === selected) ?? flow?.events[0] ?? null;

  /** Who acts at a stage, for the line under its box. */
  const actsOn = (eventKey: string) =>
    rules
      .filter((rule) => rule.event_key === eventKey && rule.locked)
      .map((rule) => recipientLabel(rule, nameOf))
      .join(", ");

  // Branches whose start (and, for a loop, end) are known steps are drawn;
  // anything else is listed plainly rather than drawn from a guess.
  const stepIndex = (key: string | null | undefined) => shape.path.findIndex((event) => event.key === key);
  const drawnBranches = shape.along
    .filter((side) => stepIndex(side.branch_from) !== -1 && (!side.returns_to || stepIndex(side.returns_to) !== -1))
    .map((side) => ({
      key: side.key,
      label: side.stage_label,
      from: stepIndex(side.branch_from),
      to: side.returns_to ? stepIndex(side.returns_to) : null,
    }));
  const drawnKeys = new Set(drawnBranches.map((branch) => branch.key));
  const unplaced = shape.along.filter((side) => !drawnKeys.has(side.key));

  /** "The Manager acts", for a box's second line. */
  const actsLine = (eventKey: string) => {
    const acts = actsOn(eventKey);
    return acts ? `${acts} acts` : undefined;
  };

  return (
    <section className="w-full rounded-lg border bg-card grade-surface shadow-raised-lg">
      <div className="space-y-3 border-b px-5 py-4">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">Notifications</h2>
          <p className="text-xs text-muted-foreground">
            Pick a process, then a stage, to choose who is told — in the app and by email. Who approves each step is
            set by the approval routing; adding someone here only means they are told as well.
          </p>
        </div>

        <div role="tablist" aria-label="Process" className="flex flex-wrap gap-1.5">
          {flows.map((candidate) => (
            <Button
              key={candidate.key}
              type="button"
              role="tab"
              size="sm"
              aria-selected={candidate.key === flow?.key}
              variant={candidate.key === flow?.key ? "default" : "outline"}
              onClick={() => {
                setActiveFlow(candidate.key);
                setSelected(candidate.events[0]?.key ?? null);
              }}
            >
              {candidate.label}
            </Button>
          ))}
        </div>
      </div>

      {flow ? (
        <div className="space-y-5 p-5">
          {/* THE FLOW, as a flowchart — see flow-diagram.tsx. */}
          {shape.path.length > 0 ? (
            <FlowDiagram
              steps={shape.path.map((event) => ({ key: event.key, label: event.stage_label, acts: actsLine(event.key) }))}
              outcomes={shape.outcomes.map((event) => ({
                key: event.key,
                label: event.stage_label,
                acts: actsLine(event.key),
                tone: outcomeTone(event),
              }))}
              branches={drawnBranches}
              selected={selectedEvent?.key ?? null}
              onSelect={setSelected}
            />
          ) : null}

          {/* Side events with no known branch point (before P14-12 is applied),
              and every event of a process that is not a sequence (Tasks):
              plain buttons, never arrows drawn from a guess. */}
          {unplaced.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {unplaced.map((event) => (
                <Button
                  key={event.key}
                  type="button"
                  size="sm"
                  variant={event.key === selectedEvent?.key ? "default" : "outline"}
                  onClick={() => setSelected(event.key)}
                >
                  {event.stage_label}
                </Button>
              ))}
            </div>
          ) : null}

          {/* THE SELECTED STAGE'S SETTINGS. */}
          {selectedEvent ? (
            <StageCard
              key={selectedEvent.key}
              event={selectedEvent}
              rules={rules.filter((rule) => rule.event_key === selectedEvent.key)}
              people={people}
              nameOf={nameOf}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function recipientLabel(rule: NotificationRule, nameOf: Map<string, string>): string {
  if (rule.audience_kind === "relationship") return relationshipLabel(rule.audience ?? "", rule.event_key);
  if (rule.audience_kind === "role") {
    const label = ROLE_LABELS[rule.audience as Role]?.label ?? rule.audience ?? "";
    return `Every ${label}`;
  }
  return nameOf.get(rule.user_id ?? "") ?? "A former colleague";
}

function StageCard({
  event,
  rules,
  people,
  nameOf,
}: {
  event: NotificationEvent;
  rules: NotificationRule[];
  people: { id: string; full_name: string }[];
  nameOf: Map<string, string>;
}) {
  const [pending, startTransition] = useTransition();

  const byLabel = (a: NotificationRule, b: NotificationRule) =>
    KIND_ORDER.indexOf(a.audience_kind) - KIND_ORDER.indexOf(b.audience_kind) ||
    recipientLabel(a, nameOf).localeCompare(recipientLabel(b, nameOf));

  // Locked rows are the people the step waits on — its approvers.
  const approvers = rules.filter((rule) => rule.locked).sort(byLabel);
  const alsoTold = rules.filter((rule) => !rule.locked).sort(byLabel);

  const taken = new Set(rules.map((rule) => `${rule.audience_kind}:${rule.audience ?? rule.user_id}`));
  const roleOptions = ADDABLE_ROLES.filter((role) => !taken.has(`role:${role}`));
  const personOptions = people.filter((person) => !taken.has(`user:${person.id}`));
  const addItems = Object.fromEntries([
    ...roleOptions.map((role) => [`role:${role}`, `Every ${ROLE_LABELS[role].label}`]),
    ...personOptions.map((person) => [`user:${person.id}`, person.full_name]),
  ]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.error ?? "Could not save that.");
    });
  }

  function add(value: string) {
    const [kind, id] = value.split(":");
    run(() =>
      addNotificationRule(
        kind === "role"
          ? { event_key: event.key, audience_kind: "role", audience: id }
          : { event_key: event.key, audience_kind: "user", user_id: id },
      ),
    );
  }

  const row = (rule: NotificationRule) => {
    const label = recipientLabel(rule, nameOf);
    return (
      <li key={rule.id} className={cn(ROW_GRID, "px-4 py-2.5")}>
        <div className="min-w-0">
          <p className="truncate text-sm" title={label}>
            {label}
          </p>
          <p className="text-2xs text-muted-foreground">{KIND_LABEL[rule.audience_kind]}</p>
        </div>
        <div className="flex justify-center">
          <Switch
            aria-label={`In-app for ${label}`}
            checked={rule.in_app}
            disabled={pending}
            onCheckedChange={(checked) =>
              run(() => updateNotificationRule({ id: rule.id, in_app: checked, email: rule.email }))
            }
          />
        </div>
        <div className="flex justify-center">
          <Switch
            aria-label={`Email for ${label}`}
            checked={rule.email}
            disabled={pending}
            onCheckedChange={(checked) =>
              run(() => updateNotificationRule({ id: rule.id, in_app: rule.in_app, email: checked }))
            }
          />
        </div>
        <div className="flex justify-center">
          {rule.audience_kind === "relationship" ? null : (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Stop telling ${label}`}
              disabled={pending}
              onClick={() => run(() => removeNotificationRule({ id: rule.id }))}
            >
              <X />
            </Button>
          )}
        </div>
      </li>
    );
  };

  const groupHeading = (text: string) => (
    <div className={cn(ROW_GRID, "border-y bg-muted px-4 py-1.5 text-2xs font-medium text-muted-foreground")}>
      <span>{text}</span>
      <span className="text-center">In-app</span>
      <span className="text-center">Email</span>
      <span className="sr-only">Remove</span>
    </div>
  );

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-sm font-semibold">{event.stage_label}</h4>
          {event.description ? <p className="text-xs text-muted-foreground">{event.description}</p> : null}
        </div>
        {event.ends_flow ? <Chip tone={outcomeTone(event)} label="Ends the process" /> : null}
      </div>

      {approvers.length > 0 ? (
        <>
          {groupHeading("Needs to act")}
          <ul className="divide-y">{approvers.map(row)}</ul>
        </>
      ) : null}

      {groupHeading(approvers.length > 0 ? "Also told" : "Told")}
      <ul className="divide-y">
        {alsoTold.length === 0 ? (
          <li className="px-4 py-2.5 text-xs text-muted-foreground">Nobody else.</li>
        ) : null}
        {alsoTold.map(row)}
      </ul>

      {roleOptions.length + personOptions.length > 0 ? (
        <div className="border-t bg-muted/50 px-4 py-2">
          <Select items={addItems} value={null} onValueChange={(value) => value && add(String(value))}>
            <SelectTrigger size="sm" className="w-full sm:w-72" aria-label={`Also tell someone at ${event.stage_label}`}>
              <Plus aria-hidden className="size-3.5 text-muted-foreground" />
              <SelectValue placeholder="Also tell a role or person" />
            </SelectTrigger>
            <SelectContent>
              {roleOptions.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>Roles</SelectLabel>
                  {roleOptions.map((role) => (
                    <SelectItem key={role} value={`role:${role}`}>
                      Every {ROLE_LABELS[role].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {roleOptions.length > 0 && personOptions.length > 0 ? <SelectSeparator /> : null}
              {personOptions.length > 0 ? (
                <SelectGroup>
                  <SelectLabel>People</SelectLabel>
                  {personOptions.map((person) => (
                    <SelectItem key={person.id} value={`user:${person.id}`}>
                      {person.full_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useMemo, useState, useTransition } from "react";
import { Lock, Plus, X } from "lucide-react";

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import type { Role } from "@/lib/auth/roles";
import { relationshipLabel } from "@/lib/schemas/notification-rules";
import { ROLE_LABELS } from "@/lib/schemas/users";

import { addNotificationRule, removeNotificationRule, updateNotificationRule } from "./actions";

export type NotificationEvent = {
  key: string;
  flow: string;
  flow_label: string;
  flow_sort: number;
  stage_label: string;
  sort: number;
  ends_flow: boolean;
  description: string;
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

/**
 * P14-09 — WHO IS TOLD, PER STAGE, PER PROCESS.
 *
 * Processes down the left, their stages on the right. Each stage lists its
 * recipients with an In-app and an Email switch; every change saves on its own.
 * Process recipients can be switched off but not removed; roles and named
 * people can be added and removed. A LOCKED recipient is somebody the step is
 * waiting on — their in-app switch stays on, because unticking it would stall
 * the approval silently.
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

  const [active, setActive] = useState(flows[0]?.key ?? "");

  return (
    <section className="w-full rounded-lg border bg-card grade-surface shadow-raised-lg">
      <div className="space-y-1 border-b px-5 py-4">
        <h2 className="text-lg font-medium">Notifications</h2>
        <p className="text-xs text-muted-foreground">
          Who is told at each stage, in the app and by email. Changes save straight away and apply to notifications
          sent from now on.
        </p>
      </div>

      <Tabs
        orientation="vertical"
        value={active}
        onValueChange={(value) => setActive(String(value))}
        className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start"
      >
        <TabsList className="w-full shrink-0 items-stretch lg:sticky lg:top-20 lg:w-64">
          {flows.map((flow) => (
            <TabsTrigger key={flow.key} value={flow.key} className="h-9 justify-between px-3 text-left">
              <span className="truncate">{flow.label}</span>
              <span className="text-2xs tabular-nums text-muted-foreground">{flow.events.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {flows.map((flow) => (
          <TabsContent key={flow.key} value={flow.key} className="min-w-0 flex-1 space-y-4">
            {flow.events.map((event) => (
              <StageCard
                key={event.key}
                event={event}
                rules={rules.filter((rule) => rule.event_key === event.key)}
                people={people}
                nameOf={nameOf}
              />
            ))}
          </TabsContent>
        ))}
      </Tabs>
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

  const ordered = [...rules].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.audience_kind) - KIND_ORDER.indexOf(b.audience_kind) ||
      recipientLabel(a, nameOf).localeCompare(recipientLabel(b, nameOf)),
  );

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

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-sm font-semibold">{event.stage_label}</h3>
          {event.description ? <p className="text-xs text-muted-foreground">{event.description}</p> : null}
        </div>
        {event.ends_flow ? <Chip tone="neutral" label="Ends the process" /> : null}
      </div>

      <div className={`${ROW_GRID} border-y bg-muted px-4 py-1.5 text-2xs font-medium text-muted-foreground`}>
        <span>Recipient</span>
        <span className="text-center">In-app</span>
        <span className="text-center">Email</span>
        <span className="sr-only">Remove</span>
      </div>

      <ul className="divide-y">
        {ordered.length === 0 ? (
          <li className="px-4 py-3 text-xs text-muted-foreground">
            Nobody is told at this stage. Add a role or a person below.
          </li>
        ) : null}
        {ordered.map((rule) => {
          const label = recipientLabel(rule, nameOf);
          return (
            <li key={rule.id} className={`${ROW_GRID} px-4 py-2.5`}>
              <div className="min-w-0">
                <p className="truncate text-sm" title={label}>
                  {label}
                </p>
                <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                  {rule.locked ? (
                    <>
                      <Lock aria-hidden className="size-3" />
                      Approves this step — always told in the app
                    </>
                  ) : (
                    KIND_LABEL[rule.audience_kind]
                  )}
                </p>
              </div>
              <div className="flex justify-center">
                <Switch
                  aria-label={`In-app for ${label}`}
                  checked={rule.in_app}
                  disabled={pending || rule.locked}
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
                    aria-label={`Remove ${label}`}
                    disabled={pending}
                    onClick={() => run(() => removeNotificationRule({ id: rule.id }))}
                  >
                    <X />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {roleOptions.length + personOptions.length > 0 ? (
        <div className="border-t bg-muted/50 px-4 py-2">
          <Select items={addItems} value={null} onValueChange={(value) => value && add(String(value))}>
            <SelectTrigger
              size="sm"
              className="w-full sm:w-72"
              aria-label={`Add a recipient to ${event.stage_label}`}
            >
              <Plus aria-hidden className="size-3.5 text-muted-foreground" />
              <SelectValue placeholder="Add a role or a person" />
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

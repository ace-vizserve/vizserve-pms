import { z } from "zod";

import { roleSchema } from "@/lib/schemas/users";

/**
 * P14-09 — the contract for the per-stage notification settings on
 * /admin/settings. The database is the enforcement (policies, the locked
 * in-app constraint, the relationship guard trigger); these only shape input.
 */

export const updateNotificationRuleSchema = z.object({
  id: z.uuid(),
  in_app: z.boolean(),
  email: z.boolean(),
});

/** Admin adds ROLE and PERSON recipients; relationships come from migrations. */
export const addNotificationRuleSchema = z.discriminatedUnion("audience_kind", [
  z.object({ event_key: z.string().min(1), audience_kind: z.literal("role"), audience: roleSchema }),
  z.object({ event_key: z.string().min(1), audience_kind: z.literal("user"), user_id: z.uuid() }),
]);

export const removeNotificationRuleSchema = z.object({ id: z.uuid() });

/**
 * How each relationship a process names reads on the settings screen. Keys are
 * the `audience` values the database functions supply to vizserve_pms_emit.
 */
export const RELATIONSHIP_LABELS: Record<string, string> = {
  dept_team_leaders: "The department's Team Leaders",
  pic: "PIC",
  qa: "QA",
  assignees: "Everyone on the task",
  relievers: "The relievers",
  approvers: "Whoever the step is waiting on",
  requester: "The requester",
  affected: "Whoever it was waiting on, or who had signed",
  owner: "The person who submitted it",
  assignee: "The person assigned",
  mentioned: "The person mentioned",
  pic_and_qa: "PIC and QA",
};

/**
 * `approvers` is whoever the step waits on, and that is always a ROLE the
 * routing already decides (P14-04): the department's Team Leaders at a Team
 * Leader step, the Manager at a Manager step and for timesheets. Named here so
 * nobody thinks they have to assign a person.
 */
export function relationshipLabel(key: string, eventKey?: string): string {
  if (key === "approvers" && eventKey) {
    if (eventKey.endsWith(".team_leader_step")) return "The department's Team Leaders";
    return "The Manager";
  }
  return RELATIONSHIP_LABELS[key] ?? key.replace(/_/g, " ");
}

# Phases 5 and 6 — DTR, Internal Approvals, Timesheet, Reporting

Specified now so the schema in Phase 0 does not have to be rewritten. **Build after Phase 4.**

---

# Phase 5 — DTR and Internal Approvals

**Retires:** the internal half of Teams Approvals. **Relative size:** medium — the DTR date logic is the hard part.

**Reuses the Phase 2 approval engine.** The four internal request types are new request types and new forms — not new approval logic. If this phase finds itself rebuilding approve/return/reject, the Phase 2 abstraction failed and that is the bug to fix.

## Track split

| Ace | Kurt |
|---|---|
| P5-01/05 migrations · P5-02 punch logic · P5-07 routing onto the existing engine · P5-08 decisions · P5-09 DTR correction write-back · P5-11 export · P5-12 `lib/dates.ts` extension | P5-03 dashboard punch shortcut · P5-04 DTR list view · P5-06 the four request forms · P5-10 approvals list view |

## DTR rules, as stated

Amier, 19:10–21:00. Verbatim intent:

- Default view is a **list** of time in / time out by date. *"Default view nyan, pag-click, is yung list view lang ng mga time in, time out."*
- **Earliest time-in wins.** *"kung ano yung time in mo na earliest, yun yung maka-capture. Kahit mag-in ka ng mag-in... hindi na siya maka-capture."*
- **Latest time-out wins.** *"kahit mag-out ka ng mag-out, yung pinaka-late, yun yung maka-capture mo."*
- **Date selection allowed on time-out only, and only for the next day.** *"pwede ako mag-out, no? Yung the next day lang."* His worked example: in 22:00 on Jul 22, out 01:00 on Jul 23 → must record against **Jul 22**, or the day shows no out.

## The problem with the rule as stated — `[RISK] R3`

"The user selects the date" plus "earliest in wins, never overwritten" produces two failure modes:

1. **No correction path.** An accidental 06:00 punch-in can never be fixed by the user, because earliest wins permanently.
2. **Backdating.** If the date picker is unconstrained, a user can attach a punch to a favourable past date.

Recommended constraints, for Amier to confirm (Q4):

- The **server timestamp is always authoritative** for the punch itself. The date picker only chooses which `work_date` the punch attaches to.
- Time-**in**: always attaches to today. No picker.
- Time-**out**: may attach to today or **yesterday only**, and only if yesterday's record has a time-in and no time-out.
- Reject a time-out more than N hours after its time-in (suggest 18) — a stale open shift is a data-entry error, not a real shift.
- **Corrections go through the Approvals module**, via `No Time-In` / `No Time-Out` requests. This is exactly why those two form types exist, and it closes the loop between the two modules.

**Also unaddressed in the call (Q8):** staff whose entire shift crosses midnight — is a 22:00–06:00 shift one work_date or two? The current rule handles OT that runs late, not scheduled night shifts. VizServe may not have night shifts today; confirm before building.

## Internal approval types

Fixed list at launch: **Leave**, **No Time-In**, **No Time-Out**, **Reimbursement**. Amier, 22:00–23:30.

**Leave balances are deliberately out of scope.** Amier, 22:40: *"actually yung mga leave, komplikado rin, may mga leave balance, pero tayo naman ngayon, ma-implement lang ng pinakamabilis... si HR muna, ang, or si Sir Joel muna, yung mag-manual count... Ang mahalaga lang, may record."*

This is the single easiest place for scope to explode. Accrual rules, carry-over, pro-rating, holiday calendars — all of it is a project on its own. He waved it off. Keep it waved off.

## Backlog

| ID | Item | Owner |
|----|------|-------|
| P5-01 | `vizserve_pms_dtr_entries` migration with `UNIQUE (user_id, work_date)` | Ace |
| P5-02 | Punch endpoint implementing earliest-in / latest-out, with the Q4 constraints | Ace |
| P5-03 | Dashboard time in/out shortcut — activate the Phase 0 placeholder | Kurt |
| P5-04 | DTR list view, department- and role-scoped | Kurt |
| P5-05 | `vizserve_pms_internal_requests` migration | Ace |
| P5-06 | Four request type forms, private (authenticated) only | Kurt |
| P5-07 | Approval routing by requester's department to that department's TL/manager | Ace |
| P5-08 | Approve/reject with mandatory reason on reject | Ace |
| P5-09 | **No Time-In / No Time-Out approval writes the correction into `dtr_entries`** | Ace |
| P5-10 | Approvals list view: my requests, and requests pending my approval | Kurt |
| P5-11 | DTR export for payroll — `xlsx` (SheetJS), same as the SIS masterfile export | Ace |
| P5-12 | Extend `lib/dates.ts` for work-date normalisation and Asia/Manila handling, with Vitest coverage. **Do not import a date library** — house rule | Ace |

## Exit criteria

- [ ] Double punch-in does not change time-in; double punch-out does update time-out.
- [ ] An OT shift ending 01:00 lands on the prior work date.
- [ ] All four internal request types submit and route correctly.
- [ ] An approved No Time-In **actually corrects** the DTR record.
- [ ] No leave-balance logic exists anywhere in the codebase.
- [ ] Payroll can export a month of DTR as CSV.

---

# Phase 6 — Timesheet, Reporting, Archive

**Retires:** ClickUp. This is the phase that lets Amier cancel the subscription (56:30: *"Di na tayo magbabayad nung ano"*). **Relative size:** medium — mostly reads over data that already exists.

## Track split

| Ace | Kurt |
|---|---|
| P6-01 migration · P6-04 turnaround reporting · P6-06 negotiation + auto-complete splits · P6-08 archive · P6-09 exports | P6-02 timesheet entry UI · P6-03 week view · P6-05 dashboards · P6-07 feedback report |

**Joint:** P6-10, ClickUp migration and cutover.

## Timesheet rule

Amier, 33:20–34:40: time is logged **against a task chosen from a list**. Free-text logging is forbidden. *"mamap niya yung item mo sa list... hindi ka rin pwede-pwede mag-log ng gusto mo."*

`vizserve_pms_timesheet_entries.task_id` is `NOT NULL`. That single constraint is the whole feature.

## Reporting — what Amier actually asked to see

Scattered across the call, but consistent:

| Metric | Source | Why he wants it |
|---|---|---|
| Turnaround time per request | `sla_started_at` → `completed_at` | Named as a dashboard element by Ace at 15:02 |
| Requests by status, by department | `requests` + `tasks` | Dashboard "Incoming/Outgoing/Ongoing/Pending" — Overall Workflow frame |
| **Negotiated vs original target date** | `target_date` vs `approved_target_date` | Proves Gate 1 is working, not rubber-stamping |
| **Client-approved vs auto-completed** | `client_decisions.decision` | The single number that shows whether clients are engaging |
| Time in `WAITING_FOR_INFO` | `task_status_history` | Where the SLA clock hides |
| Feedback rating per form / department | `feedback` | 54:30 |
| Actual hours vs turnaround | `timesheet_entries` | Real output per member — 53:30 *"makita talaga yung totoong output ng member"* |

The third and fourth rows are the ones nobody asks for and everybody needs. They are the evidence Amier wants when he takes this conversation to the client (~46:30: *"Pag nagawa natin yan, i-discuss ko yan sa kanila. Dapat maging ganito yung process namin"*).

## Backlog

| ID | Item | Owner |
|----|------|-------|
| P6-01 | `vizserve_pms_timesheet_entries` migration, `task_id NOT NULL` | Ace |
| P6-02 | Timesheet entry UI with task picker scoped to the user's assigned tasks | Kurt |
| P6-03 | Timesheet table/week view | Kurt |
| P6-04 | Turnaround time reporting with date-range filter | Ace |
| P6-05 | Status/volume dashboards per department | Kurt |
| P6-06 | Negotiation and auto-complete split reports | Ace |
| P6-07 | Feedback results report | Kurt |
| P6-08 | Archive: closed requests + audit logs, still queryable | Ace |
| P6-09 | CSV export across reports | Ace |
| P6-10 | ClickUp migration + cutover plan | Ace + Kurt |

## Exit criteria

- [ ] Time cannot be logged without a task.
- [ ] All seven metrics above are reportable with a date range.
- [ ] Archived requests remain queryable.
- [ ] A written cutover plan exists and ClickUp can be cancelled without data loss.

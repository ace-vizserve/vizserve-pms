# Phase 3 — Tasks and Internal QA (Gate 2)

**Goal:** approved requests become trackable work; members record what they actually produced; a QA reviewer checks it against the client's specs before anything reaches the client.

**Depends on:** Phase 2. **Relative size: the largest phase in the set** — roughly twice Phase 0.

## Track split

| Ace | Kurt |
|---|---|
| P3-01/02 migrations · P3-06 status machine · P3-07 resolution DB gate · P3-09/10 QA pass + reject · P3-11 waiting-for-info · P3-13 attachments · P3-15 scope tests | P3-03 task list view · P3-04 board view · P3-05 task detail · P3-08 QA screen · P3-12 manual creation · P3-14 my tasks + dashboard card |

**Contract, agreed before either track starts:** the task zod schema plus the legal-transition table below, as a typed constant both tracks import.

## Pre-planned split — decide early, not late

- **3a** — lists, task list view, task detail, status machine, resolution gate, manual tasks
- **3b** — QA screens, QA pass/reject, board view, `WAITING_FOR_INFO` reporting

3a alone is a usable increment; a half-finished Phase 3 is not — and this is the worst place in the whole plan to stall, since Phase 4 depends on it entirely. Make the call on whether to split as soon as the shape of the work is clear, not once it is already dragging.

---

## The correction this phase carries

Ace's Miro frame *Ticket Processing* has:

```
Testing/QA → Completed → Submit for Final Approval → End
```

That is wrong. Amier corrected himself live at 42:20–42:40 (*"Tapos, hindi pala. Yung Finish dapat for QA"*). `Completed` is terminal, after the **client** signs off. Correct order:

```
OPEN → ONGOING → FOR_QA → QA_IN_PROGRESS → FOR_CLIENT_APPROVAL → COMPLETED
```

Ship the wrong order and the word "Completed" means nothing, which breaks every report in Phase 6.

---

## The resolution field

Amier, 52:00–53:15, describing what a member must record before handing off:

> *"May isa ka lang field doon na text field... Humbawa, si Ryza nag-fix ng issue. Ano yung ginawa? Resolution, parang ganon... Pag-collaterals naman, parang ganon din. Ano yung ginawa? ... Pero kung sa collaterals, please see link."*

This does not exist anywhere in the Miro board and it is load-bearing. Without it:

- the QA reviewer has nothing to review against;
- the client approval email in Phase 4 is an empty shell;
- Amier's stated goal at 53:30 — *"makita talaga yung totoong output ng member"* — is unmet.

Make it **required at the database level** for the `ONGOING → FOR_QA` transition. Not a UI hint.

---

## Backlog

| ID | Item | Detail | Owner |
|----|------|--------|-------|
| P3-01 | `vizserve_pms_lists` migration + CRUD | List per helpdesk area or project, department-scoped — Amier 33:00 | Ace |
| P3-02 | `vizserve_pms_tasks` + `vizserve_pms_task_status_history` migration | Full status enum, `resolution`, `output_link`, `qa_assignee_id`, nullable `request_id` | Ace |
| P3-03 | Task list view | Columns derived from the originating form's fields — Amier 41:00. Plus status, PIC, QA, due date | Kurt |
| P3-04 | Task board view | Kanban by status. Optional if list view ships first; the list view is the requirement | Kurt |
| P3-05 | Task detail view | All inherited fields, attachments, status history with comments, resolution editor | Kurt |
| P3-06 | Status transition engine | Server-side state machine. Illegal transitions rejected. Every transition writes `task_status_history` | Ace |
| P3-07 | **Resolution gate** | DB constraint/trigger: `FOR_QA` unreachable while `resolution` is null or empty | Ace |
| P3-08 | QA screen | QA assignee sees `FOR_QA` items, opens, reviews resolution + output against the original request side by side | Kurt |
| P3-09 | QA pass | `QA_IN_PROGRESS → FOR_CLIENT_APPROVAL`. Notifies nobody outside yet — Phase 4 wires the email | Ace |
| P3-10 | QA reject | `QA_IN_PROGRESS → ONGOING`, **comment required**, PIC notified, comment visible on the task | Ace |
| P3-11 | `WAITING_FOR_INFO` | Kept from Miro's `Need More Info` branch. Requires a note on entry. Duration derived from history — `[RISK] R4` | Ace |
| P3-12 | Manual task creation | Create a task with no request behind it — Amier 33:20 | Kurt |
| P3-13 | Task attachments | Output files uploaded by the PIC, surfaced later on the client approval page | Ace |
| P3-14 | My Tasks + dashboard card | Member's own open work, sorted by due date | Kurt |
| P3-15 | Scope tests | Member sees only tasks where they are PIC or QA; TL/manager see department; admin sees all | Ace |

---

## Status transitions — the whole legal set

| From | To | Who | Required |
|---|---|---|---|
| `OPEN` | `ONGOING` | PIC | — |
| `ONGOING` | `WAITING_FOR_INFO` | PIC | note |
| `WAITING_FOR_INFO` | `ONGOING` | PIC | — |
| `ONGOING` | `FOR_QA` | PIC | **resolution non-empty** |
| `FOR_QA` | `QA_IN_PROGRESS` | QA | — |
| `QA_IN_PROGRESS` | `ONGOING` | QA | comment |
| `QA_IN_PROGRESS` | `FOR_CLIENT_APPROVAL` | QA | — |
| `FOR_CLIENT_APPROVAL` | `ONGOING` | client (Phase 4) | comment |
| `FOR_CLIENT_APPROVAL` | `COMPLETED` | client (Phase 4) | — |
| `FOR_CLIENT_APPROVAL` | `COMPLETED_NO_RESPONSE` | system (Phase 4) | — |

Anything not in this table is rejected by `P3-06`. In Phase 3, the last three rows are exercised by an admin-only test action; Phase 4 replaces that with the real client path.

**Open question Q5:** should a TL be able to force a status change (e.g. reopen a completed task, or move a stuck ticket)? Not discussed in the call. Real systems need it; unlogged, it destroys the audit trail. Recommendation: allow it for TL and admin, always with a mandatory reason, and flag it distinctly in history.

---

## Out of scope

- Timesheet logging against tasks — Phase 6
- Subtasks, dependencies, checklists
- Time estimates and burndown
- Client visibility of task status — the client sees the request at submission and at approval, nothing in between. That is intentional.

---

## Exit criteria

- [ ] Every legal transition works; every illegal one is rejected server-side.
- [ ] A direct API call cannot move a task to `FOR_QA` with an empty resolution.
- [ ] QA reject returns to `ONGOING` with the comment visible to the PIC.
- [ ] Task list columns reflect the originating form's fields.
- [ ] Manual tasks can be created without a request.
- [ ] `WAITING_FOR_INFO` total duration is queryable per task.
- [ ] `P3-15` scope tests are green.

# Phase 2 — Approval Engine + Gate 1

**Goal:** build the approval machinery **once, generically**, then wire the client-request Team Leader gate onto it as its first consumer.

**Depends on:** Phase 1. **Relative size:** medium — small surface area, high care. The engine is reused twice.

---

## The engine comes first

Phase 5's internal approvals (leave, no time-in, no time-out, reimbursement) are the *same shape* as this gate: a pending item, an approver determined by department, a decision, a reason, an audit entry, a notification. Building that twice is the most obvious avoidable waste in this plan.

**The generic engine** — everything a second request type would need, and nothing more:

| Concern | Generic | Client-request-specific |
|---|---|---|
| Pending item routed to an approver by department | ✅ engine | |
| `approve` / `return` / `reject` transitions | ✅ engine | |
| Mandatory reason on `return` and `reject` | ✅ engine | |
| Audit entry with before/after | ✅ engine | |
| Notification to requester and approver | ✅ engine | |
| "Pending my approval" query | ✅ engine | |
| Capacity panel | | ❌ Gate 1 only |
| PIC + QA assignment | | ❌ Gate 1 only |
| Edit target date before approving | | ❌ Gate 1 only |
| Task creation on approve | | ❌ Gate 1 only |

Implement the engine as a small set of Postgres functions plus a typed server-side module, taking `(entity_type, entity_id, approver_id, decision, reason)`. The client-request specifics compose *around* it — an approve call that also runs the task-creation transaction — never *inside* it.

**Acceptance test for genericity:** a throwaway second request type routes through the engine end to end without touching engine code. If that requires a change to the engine, the abstraction is wrong and Phase 5 will be a rewrite.

---

## Track split

| Ace | Kurt |
|---|---|
| Generic engine · P2-02 capacity query · P2-03 edit-before-approve · P2-07 approval transaction · P2-08/09 return + reject · P2-13 authz tests | P2-01 review screen · P2-02 capacity panel UI · P2-04/05 PIC + QA selectors · P2-06 list selector · P2-10 pending queue · P2-11 dashboard shortcut · P2-12 notification surfacing |

**Contract, agreed before either track starts:** the decision payload zod schema in `lib/schemas/`. Both tracks depend on it.

---

## What this gate is for

Amier, 37:00–38:40, is the clearest statement of intent in the whole call:

> *"Ngayon kasi mapapansin nyo, tanggap lang ng tanggap yung mga members natin. Walang validation... Unlike kung may ganyan, dadaan muna kay team leader, ma-assess niya. Kung kaya pa gawin to with this target date... Plus yung load nung tao niya, kaya pa ba? Kasi kung hindi, dapat maigi pag-negotiate siya. Yun yung trabaho ng team leader. Para hindi ma-burn out yung tao."*

Two design consequences follow, and both are easy to miss:

1. **The TL must be able to see the load at decision time.** A review screen showing only the request is a rubber stamp with extra clicks. If the TL has to open another tab to check whether the assignee is drowning, they will not do it, and the gate does nothing.
2. **Negotiation is the primary path, rejection the exception.** Amier: *"Dapat di tayo nagre-reject, eh, di ba?"* The UI should make "approve with an adjusted date" the most prominent action — not bury it behind a reject flow.

---

## Backlog

| ID | Item | Detail | Owner |
|----|------|--------|-------|
| P2-00 | **Generic approval engine** | Routing by department, approve/return/reject, mandatory reason, audit, notify, "pending my approval" query. Consumed by Gate 1 now and Phase 5 later | Ace |
| P2-01 | TL review screen | Full request detail, attachments, requester info, original target date | Kurt |
| P2-02 | **Capacity panel** | On the same screen: for each candidate assignee in the department — open ticket count by status, nearest 3 due dates, count already due before this request's target date | Ace |
| P2-03 | Edit-before-approve | TL can set `approved_target_date` (defaults to `target_date`), and correct title/description typos. Every edit written to `audit_logs` with before/after | Ace |
| P2-04 | Assign PIC | Assignee selector, scoped to the TL's department(s) | Kurt |
| P2-05 | Assign QA | Second selector. **Defaults to the approving TL**, overridable to any member of the department — Amier 41:30 | Kurt |
| P2-06 | Target list selection | Defaults to the form's `default_list_id`, overridable | Kurt |
| P2-07 | Approve action | Transaction: set request `APPROVED`, create `tasks` row with `OPEN`, copy `field_values`, set `due_date = approved_target_date`, set PIC + QA, write audit log, notify PIC | Ace |
| P2-08 | Return action | Status `RETURNED`, **reason required**, emailed to `requester_email` with the reason and a link to resubmit | Ace |
| P2-09 | Reject action | Status `REJECTED` (terminal), **reason required**, emailed to requester | Ace |
| P2-10 | Pending approvals queue | TL landing list, sorted by target date ascending. Overdue and near-due visually distinct | Kurt |
| P2-11 | Dashboard shortcut | "Pending approvals" card links here — the dashboard shortcut Amier described at 16:30 | Kurt |
| P2-12 | Notifications | PIC notified on assignment; QA notified that they are QA; requester emailed on any decision | Kurt |
| P2-13 | Authorization tests | A TL cannot open, approve, or assign on a request outside their departments — asserted at the API layer | Ace |

---

## Approval transaction — get this right

`P2-07` writes to four tables. It must be atomic. A half-approved request (status changed, no task created) is the kind of bug that erodes trust in the system permanently, and the team will go back to ClickUp.

```
BEGIN
  UPDATE requests SET status='APPROVED', approved_target_date=$1,
                      reviewed_by=$2, reviewed_at=now()
  INSERT INTO tasks (..., status='OPEN', request_id=..., assignee_id=$3,
                     qa_assignee_id=$4, due_date=$1, field_values=<copied>)
  INSERT INTO audit_logs (entity='request', action='approved', before, after)
  INSERT INTO notifications (user_id=$3, type='assigned'), (user_id=$4, type='qa_requested')
COMMIT
```

Wrap it in a single Postgres function. Do not orchestrate it from the Next.js server action with four separate calls.

---

## Screen sketch — TL review

```
┌──────────────────────────────────────────────────────────────────┐
│ COL-2026-0142 · Collateral Request Form         [PENDING REVIEW] │
│ Juan dela Cruz · juan@hfse.edu.sg · HFSE Marketing               │
├───────────────────────────────┬──────────────────────────────────┤
│ REQUEST                       │ CAPACITY — VizBytes              │
│ Title, description, specs     │ ┌──────────────────────────────┐ │
│ Sizes, formats                │ │ Ryza    4 open · next Aug 3  │ │
│ Attachments (3)               │ │ Lloyd   9 open · next Jul 30 │ │
│ Client-side approver: Ms Sam  │ │ Kurt    2 open · next Aug 11 │ │
│                               │ └──────────────────────────────┘ │
│ Target date  Aug 5            │ 2 tickets already due before Aug 5│
├───────────────────────────────┴──────────────────────────────────┤
│ Approved target date [Aug 7 ▾]   PIC [Ryza ▾]   QA [Kurt (TL) ▾] │
│ List [Collateral ▾]                                              │
│                                                                  │
│           [ Approve ]      [ Return for info ]    [ Reject ]     │
└──────────────────────────────────────────────────────────────────┘
```

The capacity panel is the feature. Everything else is a form.

---

## Out of scope

- Multi-step or multi-approver chains. One TL, one decision. Amier described exactly one internal approver before work starts.
- Auto-assignment or round-robin. The whole point is human judgement about load.
- SLA escalation on unreviewed requests — sensible later; not now.

---

## Exit criteria

- [ ] **The engine is generic** — a throwaway second request type routes through it end to end without touching engine code.
- [ ] The capacity panel shows live per-assignee load on the review screen.
- [ ] Approving with an adjusted date stores **both** dates and creates a task due on the adjusted one.
- [ ] Return and reject both refuse to submit without a reason, and the reason reaches the requester by email.
- [ ] Approval is atomic — a forced failure mid-transaction leaves no partial state.
- [ ] PIC and QA are both set and both notified.
- [ ] `P2-13` cross-department authorization tests are green.

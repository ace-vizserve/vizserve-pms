# Phase 4 — Client Approval (Gate 3) and Feedback

**Goal:** the client approves or rejects finished work from an email link, without an account; non-response auto-completes after 3 days; every completion triggers a feedback request.

**Depends on:** Phase 3. **Relative size:** large — security-sensitive, and email deliverability is an unknown until tested.

## Track split

| Ace | Kurt |
|---|---|
| P4-01 token migration · P4-02 issuance · P4-05 decision handler · P4-06/07 approve + reject paths · P4-09 Vercel cron auto-complete · P4-11 feedback storage · P4-12 archive · P4-13 security tests | P4-03 approval email · P4-04 public approval page · P4-08 reminder emails · P4-10 feedback request · P4-14 deliverability check |

**Contract, agreed before either track starts:** the token payload and decision zod schemas. **Kurt should start P4-14 deliverability testing at the beginning of this phase, not the end** — it is the one item where a late failure has no workaround.

**This is the phase where the platform starts paying for itself.** Everything before it reorganises internal work. This is the part that takes VizServe's SLA out of the client's hands.

---

## What Amier specified

- **No login.** 49:00 — *"ang approval nun is email lang. So si client, hindi niya kailangan mag-login."*
- **Only the requester approves.** 43:30 — *"Kung sino lang yung requestor, siya lang dapat yung mag-a-approve."* This is a reaction to a real problem: 43:50 — *"I-design natin, tapos check pa nila, check din ni ganito, check din ni ganito. May isang magdi-indi okay... Tumatagal eh."*
- **The page shows details, comment box, attachment, approve/reject.** 53:30.
- **Reject returns the ticket** with the comment. 53:20.
- **3 days no response → complete**, and the client is told this in the email. 54:00.
- **Feedback per request**, not periodic. 54:30 — *"mas realistic kung every request, may chance silang magbigay ng feedback."*

---

## Security — this is the riskiest surface in the build

A public URL that changes state with no session. Get it wrong and anyone with a forwarded email approves anyone's work.

**Required:**

| Control | Why |
|---|---|
| Cryptographically random token, ≥256 bits | Guessing must be infeasible |
| **Store only a hash** of the token | A DB leak must not yield working approval links |
| Token bound to `task_id` **and** `requester_email` | Enforces Amier's "only the requestor" rule; a token for one task cannot act on another |
| Expiry (recommend 14 days) | Old emails stop working |
| Single decision per token — set `consumed_at` | No replay, no changing the answer after the fact |
| Rate limit by token and by IP | Blunts enumeration |
| Log IP + user agent on decision | Evidence if a client later disputes an approval |
| No table access for the `anon` role | The Next.js server route is the only path in |

**Open question Q7 — the honest limitation:** email forwarding defeats email-based identity. If Ms. Sam forwards the approval link to her manager and the manager clicks Approve, the system records Ms. Sam's approval. Amier's rule is enforceable *as far as email is enforceable* and no further. Options, for Amier to choose:

- **(a) Accept it.** The link is bound to one named person; forwarding is that person's choice and their accountability. Simplest, and probably right for a school client.
- **(b) One-time code**: the page emails a 6-digit code to `requester_email` before accepting the decision. Stops casual forwarding, adds friction to the exact step Amier wants frictionless.
- **(c) Named confirmation**: the approver types their name before submitting, and it is recorded. Weak security, decent accountability, near-zero friction.

Recommendation: **(a) now, (c) as a cheap add**. Do not build (b) unless a dispute actually happens — it fights the entire purpose of the gate.

---

## Backlog

| ID | Item | Detail | Owner |
|----|------|--------|-------|
| P4-01 | `vizserve_pms_approval_tokens` + `vizserve_pms_client_decisions` migration | Hashed token, bound email, expiry, `consumed_at`, `auto_complete_at` | Ace |
| P4-02 | Token issuance | On `QA_IN_PROGRESS → FOR_CLIENT_APPROVAL`: generate, hash, store, set `auto_complete_at = now() + 3 days` | Ace |
| P4-03 | Approval email | Reference no, request summary, resolution text, output link/attachments, the approval link, **and the auto-complete warning in plain language** | Kurt |
| P4-04 | Public approval page | `/approve/[token]`. Server-rendered. Request details, resolution, output, attachments, comment box, optional file upload, `Approve` / `Request revision` | Kurt |
| P4-05 | Decision handler | Validates token (hash, expiry, unconsumed), records `client_decisions`, transitions task, consumes token, writes audit log | Ace |
| P4-06 | Approve path | → `COMPLETED`, `completed_at` set, SLA stopped, final audit log | Ace |
| P4-07 | Reject path | → `ONGOING`, **comment required**, PIC + QA + TL notified, comment on the task | Ace |
| P4-08 | Reminder emails | At day 1 and day 2, restating the deadline. **Not optional** — see below | Kurt |
| P4-09 | Auto-complete job | **Vercel cron** (already available in the SIS stack): tasks in `FOR_CLIENT_APPROVAL` past `auto_complete_at` → `COMPLETED_NO_RESPONSE`, `client_decisions.decision = AUTO_COMPLETED`, actor = system | Ace |
| P4-10 | Feedback request | On any completion, email a 1–5 rating + comment form (same token pattern, separate token) | Kurt |
| P4-11 | `vizserve_pms_feedback` table + results view | Per request, per form type, per department | Ace |
| P4-12 | Archive + final audit log | Ticket Closure frame: update reports, archive request + audit logs, notify stakeholders internally | Ace |
| P4-13 | Security tests | Wrong token, expired token, consumed token, token from task A used on task B, decision without comment on reject — all rejected | Ace |
| P4-14 | Deliverability check | SPF/DKIM/DMARC verified; test sends to Outlook/M365, Gmail, and the client's actual domain | Kurt |

---

## `P4-08` and `P4-09`: push back a little here

Amier's rule — silence for 3 days means complete — is commercially sound and solves a real problem. It is also the feature most likely to produce an angry call, because "we never approved that" is an easy thing for a client to say and a hard thing to disprove.

Three cheap mitigations that keep the rule intact:

1. **Say it in the email, prominently.** Not a footer. Amier already specified this (54:00) — make sure it survives the design pass.
2. **Two reminders.** A single email that lands in spam should not silently close a ticket. This is `P4-08`, and it is why `P4-14` exists.
3. **Never call it "Approved."** `COMPLETED_NO_RESPONSE` is a distinct state, distinctly labelled in reporting and in the archive. If a dispute happens, the record shows exactly what occurred.

**Budget for the date maths.** The SIS repo bans date libraries — `lib/dates.ts` only. Business-day arithmetic with a PH holiday calendar is a real piece of work, not an import. See `11-stack-conventions.md`.

**Also decide (Q6):** is "3 days" calendar days or business days? A ticket sent Friday 5pm auto-completes Monday 5pm on calendar days, having given the client roughly one working day. Recommend **business days**, and put it in `forms.sla_days`-style config rather than hardcoding it.

---

## Client approval page — content

```
┌────────────────────────────────────────────────────────────┐
│ VizServe · COL-2026-0142                                   │
│ Collateral Request — "Open House 2026 poster set"          │
├────────────────────────────────────────────────────────────┤
│ You requested          Jul 22, 2026                        │
│ Agreed delivery        Aug 7, 2026                         │
│ Submitted for approval Aug 6, 2026                         │
│                                                            │
│ WHAT WAS DONE                                              │
│ <resolution text from the PIC>                             │
│                                                            │
│ OUTPUT                                                     │
│ → drive.google.com/...  ·  poster-a3.pdf  ·  poster-ig.png │
│                                                            │
│ YOUR ORIGINAL SPECS                                        │
│ <collapsed — the fields as submitted>                      │
├────────────────────────────────────────────────────────────┤
│ Comments (required if requesting revision)                 │
│ [                                                        ] │
│ Attach a file (optional)  [ Choose ]                       │
│                                                            │
│        [ Approve ]              [ Request revision ]       │
│                                                            │
│ If we don't hear from you by Aug 9, this request will be   │
│ closed as completed.                                       │
└────────────────────────────────────────────────────────────┘
```

Showing the original specs alongside the output is what makes Amier's argument at 44:30 operational: the client is approving **against what they asked for**, not re-opening the brief.

---

## Exit criteria

- [ ] Client receives an email, clicks, and approves with no login.
- [ ] `P4-13` security tests all green — especially cross-task token reuse and replay.
- [ ] Reject returns the task to `ONGOING` with the comment reaching the PIC.
- [ ] Reminders fire at day 1 and day 2; auto-complete fires on schedule; the deadline appears in the email body.
- [ ] `COMPLETED` vs `COMPLETED_NO_RESPONSE` distinguishable in the archive.
- [ ] Feedback request goes out on every completion; results are queryable.
- [ ] Deliverability verified against the client's real mail domain.

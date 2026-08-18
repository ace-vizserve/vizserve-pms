-- P7-06 — internal work moves freely, and tasks get a start date.
--
-- Two unrelated things in one file because both are small and both are about
-- the same complaint: a task a lead created by hand behaves like a client
-- ticket, and it should not have to.
--
-- ---------------------------------------------------------------------------
-- 1. Free status movement for work with no client
-- ---------------------------------------------------------------------------
--
-- The pipeline exists because CLIENT work has gates: a resolution before review,
-- a reviewer before the client, the client before it is done. None of that
-- applies to "read the brand guidelines" or "chase the supplier".
--
-- What is NOT being done here, deliberately: making `status` a writable column.
-- That single revoke is what makes "every transition is legal and every
-- transition writes history" true rather than hoped for, and it protects client
-- work as much as internal. So the freedom is added as DATA — more legal moves
-- for the categories that should have them — and the machinery is untouched.
-- Every move below still writes a history row.
--
-- Scope 'internal' rather than listing 'internal' and 'personal' separately:
-- `scopeAllows` treats personal work as a kind of internal work, because a
-- personal task IS internal work whose owner may also close it directly.

insert into vizserve_pms_task_transitions
  (from_status, to_status, actor, required_field, applies_to)
values
  -- Started it by accident, or picked it up and put it back down.
  ('ONGOING',          'OPEN',             'pic', null,      'internal'),
  ('WAITING_FOR_INFO', 'OPEN',             'pic', null,      'internal'),
  -- Parked before it was ever started. Entering WAITING_FOR_INFO still costs a
  -- note, exactly as it does from ONGOING — that note is the only thing that
  -- makes "how long was this blocked, and on what" answerable afterwards, and a
  -- rule that applies from one status and not another is a rule nobody learns.
  ('OPEN',             'WAITING_FOR_INFO', 'pic', 'comment', 'internal'),
  -- Pulled back out of review. On client work the QA reviewer sends it back
  -- with a comment; on internal work the person doing it can just take it back.
  ('FOR_QA',           'ONGOING',          'pic', null,      'internal'),
  -- Reopening. Closed too early, or it came back.
  --
  -- Only for work with no client: reopening a task the client has signed off is
  -- going behind their decision, and Gate 3 already has its own way back
  -- (FOR_CLIENT_APPROVAL -> ONGOING, when the client rejects).
  ('COMPLETED',        'ONGOING',          'pic', null,      'internal');

-- ---------------------------------------------------------------------------
-- 2. A start date
--
-- `due_date` alone answers "when must this be finished" and says nothing about
-- when it is meant to begin, which is the question a lead asks when deciding
-- whether somebody is overloaded this week or next.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_tasks
  add column start_date date;

-- Both dates are optional, and the ordering is only checked when both exist.
-- A start with no due date is an ordinary thing to record; a start AFTER the
-- due date is a typo.
alter table vizserve_pms_tasks
  add constraint vizserve_pms_tasks_start_before_due
  check (start_date is null or due_date is null or start_date <= due_date);

-- Additive, not a restatement: column-level grants accumulate, so this adds
-- `start_date` to the list established in 20260803130000 without repeating it —
-- and, importantly, without accidentally re-granting `status`.
grant update (start_date) on vizserve_pms_tasks to authenticated;
